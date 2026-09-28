import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/** Agent requests deliberately do not use trusted human identity headers. */
@Injectable()
export class AstraAgentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    const credential = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!/^dga_[A-Za-z0-9_-]{43}$/.test(credential)) throw new UnauthorizedException('Invalid DocGrid agent credential');
    request.astraCredential = credential;
    delete request.user;
    return true;
  }
}

