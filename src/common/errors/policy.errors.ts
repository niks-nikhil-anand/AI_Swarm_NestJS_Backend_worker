import { ServiceError } from './service.error';
export class PolicyError extends ServiceError {
  constructor(code: string, message: string) {
    super(code, message, 403);
  }
}
