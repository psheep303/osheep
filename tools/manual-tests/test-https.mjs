// 尝试不同的请求方式找出工作的方法
import https from 'https';

const testWithNodeHttps = () => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }]
    });

    const options = {
      hostname: 'muyuan.do',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Authorization': 'Bearer sk-REDACTED',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Origin': 'https://muyuan.do',
        'Referer': 'https://muyuan.do/',
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
};

console.log('测试使用 Node.js https 模块...');
testWithNodeHttps()
  .then(result => {
    console.log('状�?', result.status);
    console.log('响应:', result.body.slice(0, 500));
  })
  .catch(err => {
    console.error('错误:', err.message);
  });
