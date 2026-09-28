import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class DocGridAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.DOCGRID_ADMIN_TOKEN ?? '';
    if (expected.length < 32) throw new ServiceUnavailableException('DOCGRID_ADMIN_TOKEN is not configured');
    const actual = context.switchToHttp().getRequest()?.headers?.['x-docgrid-admin-token'];
    if (typeof actual !== 'string' || actual.length > 512 || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) throw new UnauthorizedException();
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new UnauthorizedException();
    return true;
  }
}

