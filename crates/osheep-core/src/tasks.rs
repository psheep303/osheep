use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

pub type TaskId = u64;
type TaskFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskPriority {
    Interactive,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TaskQueueError {
    #[error("后台任务队列已满")]
    QueueFull,
    #[error("任务不存在")]
    NotFound,
}

#[derive(Debug, Clone)]
pub struct TaskCancellation {
    cancelled: Arc<AtomicBool>,
}

impl TaskCancellation {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

struct QueuedTask {
    id: TaskId,
    cancellation: TaskCancellation,
    future: TaskFuture,
}

struct Inner {
    queue: Mutex<QueueState>,
    notify: Notify,
    next_id: AtomicU64,
    workers: usize,
}

struct QueueState {
    interactive: VecDeque<QueuedTask>,
    background: VecDeque<QueuedTask>,
    states: HashMap<TaskId, TaskState>,
    active: HashMap<TaskId, TaskCancellation>,
    paused: bool,
    pending: usize,
    max_pending: usize,
}

#[derive(Clone)]
pub struct BackgroundTaskQueue {
    inner: Arc<Inner>,
}

impl BackgroundTaskQueue {
    pub fn new(max_pending: usize, workers: usize) -> Self {
        let inner = Arc::new(Inner {
            queue: Mutex::new(QueueState {
                interactive: VecDeque::new(),
                background: VecDeque::new(),
                states: HashMap::new(),
                active: HashMap::new(),
                paused: false,
                pending: 0,
                max_pending: max_pending.max(1),
            }),
            notify: Notify::new(),
            next_id: AtomicU64::new(1),
            workers: workers.max(1),
        });
        for _ in 0..inner.workers {
            let worker = inner.clone();
            tokio::spawn(async move { run_worker(worker).await });
        }
        Self { inner }
    }

    pub async fn submit<F, Fut>(
        &self,
        priority: TaskPriority,
        task: F,
    ) -> Result<TaskId, TaskQueueError>
    where
        F: FnOnce(TaskCancellation) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = TaskCancellation {
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let queued = QueuedTask {
            id,
            cancellation: cancellation.clone(),
            future: Box::pin(task(cancellation)),
        };
        let mut state = self.inner.queue.lock().await;
        if state.pending >= state.max_pending {
            return Err(TaskQueueError::QueueFull);
        }
        state.pending += 1;
        state.states.insert(id, TaskState::Queued);
        match priority {
            TaskPriority::Interactive => state.interactive.push_back(queued),
            TaskPriority::Background => state.background.push_back(queued),
        }
        drop(state);
        self.inner.notify.notify_one();
        Ok(id)
    }

    pub async fn cancel(&self, id: TaskId) -> Result<(), TaskQueueError> {
        let mut state = self.inner.queue.lock().await;
        let task = remove_queued(&mut state.interactive, id)
            .or_else(|| remove_queued(&mut state.background, id));
        if let Some(task) = task {
            state.pending = state.pending.saturating_sub(1);
            state.states.insert(id, TaskState::Cancelled);
            task.cancellation.cancel();
            drop(task);
            self.inner.notify.notify_one();
            return Ok(());
        }
        if let Some(cancellation) = state.active.get(&id) {
            cancellation.cancel();
            return Ok(());
        }
        match state.states.get(&id) {
            Some(_) => Ok(()),
            None => Err(TaskQueueError::NotFound),
        }
    }

    pub async fn state(&self, id: TaskId) -> Result<TaskState, TaskQueueError> {
        self.inner
            .queue
            .lock()
            .await
            .states
            .get(&id)
            .copied()
            .ok_or(TaskQueueError::NotFound)
    }

    pub async fn pause_background(&self) {
        self.inner.queue.lock().await.paused = true;
    }

    pub async fn resume_background(&self) {
        self.inner.queue.lock().await.paused = false;
        self.inner.notify.notify_waiters();
    }
}

fn remove_queued(queue: &mut VecDeque<QueuedTask>, id: TaskId) -> Option<QueuedTask> {
    let index = queue.iter().position(|task| task.id == id)?;
    queue.remove(index)
}

async fn run_worker(inner: Arc<Inner>) {
    loop {
        let task = loop {
            let notified = inner.notify.notified();
            let task = {
                let mut state = inner.queue.lock().await;
                let task = state.interactive.pop_front().or_else(|| {
                    if state.paused {
                        None
                    } else {
                        state.background.pop_front()
                    }
                });
                if let Some(ref task) = task {
                    state.states.insert(task.id, TaskState::Running);
                    state.active.insert(task.id, task.cancellation.clone());
                }
                task
            };
            if let Some(task) = task {
                break task;
            }
            notified.await;
        };
        let id = task.id;
        let result = if task.cancellation.is_cancelled() {
            Err(String::new())
        } else {
            task.future.await
        };
        let mut state = inner.queue.lock().await;
        state.active.remove(&id);
        state.pending = state.pending.saturating_sub(1);
        state.states.insert(
            id,
            if task.cancellation.is_cancelled() {
                TaskState::Cancelled
            } else if result.is_ok() {
                TaskState::Completed
            } else {
                TaskState::Failed
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, timeout, Duration};

    #[tokio::test]
    async fn interactive_tasks_precede_paused_background_work() {
        let queue = BackgroundTaskQueue::new(4, 1);
        queue.pause_background().await;
        let ran = Arc::new(Mutex::new(Vec::new()));
        let background_ran = ran.clone();
        let background = queue
            .submit(TaskPriority::Background, move |_| {
                let ran = background_ran.clone();
                async move {
                    ran.lock().await.push("background");
                    Ok(())
                }
            })
            .await
            .unwrap();
        let interactive_ran = ran.clone();
        let interactive = queue
            .submit(TaskPriority::Interactive, move |_| {
                let ran = interactive_ran.clone();
                async move {
                    ran.lock().await.push("interactive");
                    Ok(())
                }
            })
            .await
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while queue.state(interactive).await.unwrap() != TaskState::Completed {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&*ran.lock().await, &["interactive"]);
        assert_eq!(queue.state(background).await.unwrap(), TaskState::Queued);
        queue.resume_background().await;
        timeout(Duration::from_secs(1), async {
            while queue.state(background).await.unwrap() != TaskState::Completed {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&*ran.lock().await, &["interactive", "background"]);
    }

    #[tokio::test]
    async fn queue_is_bounded_and_queued_tasks_can_be_cancelled() {
        let queue = BackgroundTaskQueue::new(1, 1);
        queue.pause_background().await;
        let first = queue
            .submit(TaskPriority::Background, |_| async { Ok(()) })
            .await
            .unwrap();
        let second = queue
            .submit(TaskPriority::Background, |_| async { Ok(()) })
            .await;
        assert_eq!(second, Err(TaskQueueError::QueueFull));
        queue.cancel(first).await.unwrap();
        assert_eq!(queue.state(first).await.unwrap(), TaskState::Cancelled);
    }

    #[tokio::test]
    async fn running_tasks_cooperatively_observe_cancellation() {
        let queue = BackgroundTaskQueue::new(1, 1);
        let started = Arc::new(Notify::new());
        let task_started = started.clone();
        let id = queue
            .submit(TaskPriority::Background, move |cancellation| async move {
                task_started.notify_one();
                while !cancellation.is_cancelled() {
                    sleep(Duration::from_millis(5)).await;
                }
                Ok(())
            })
            .await
            .unwrap();
        timeout(Duration::from_secs(1), started.notified())
            .await
            .unwrap();
        queue.cancel(id).await.unwrap();
        timeout(Duration::from_secs(1), async {
            while queue.state(id).await.unwrap() != TaskState::Cancelled {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn task_failure_is_recorded() {
        let queue = BackgroundTaskQueue::new(2, 1);
        let id = queue
            .submit(TaskPriority::Interactive, |_| async {
                Err("failed".into())
            })
            .await
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while queue.state(id).await.unwrap() == TaskState::Queued
                || queue.state(id).await.unwrap() == TaskState::Running
            {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(queue.state(id).await.unwrap(), TaskState::Failed);
    }
}
