import type {
  AgentTransport,
  TransportProcess,
  TransportResumeInput,
  TransportStartInput,
} from "../types.js";

export interface SdkTransportOptions {
  start(input: TransportStartInput): Promise<TransportProcess>;
  resume?(input: TransportResumeInput): Promise<TransportProcess>;
}

export class SdkTransport implements AgentTransport {
  constructor(private readonly options: SdkTransportOptions) {}
  start(input: TransportStartInput): Promise<TransportProcess> {
    return this.options.start(input);
  }
  resume(input: TransportResumeInput): Promise<TransportProcess> {
    if (!this.options.resume) return this.options.start(input);
    return this.options.resume(input);
  }
}
