import { type DocGridAccess } from '../../product-access';
import { verifyDocGridAccessToken } from '../../docgrid-identity';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

const PROVIDER = 'AI_ORCHESTRA';
const PLANS = new Set(['free', 'basic', 'standard', 'pro', 'business']);

type TrustedDocGridIdentity = {
  sub: string;
  email: string;
  name?: string | null;
  role: 'USER' | 'ADMIN';
  plan: string;
  docgridAccess?: DocGridAccess;
};

@Injectable()
export class DocGridIdentityGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  private async mirror(payload: TrustedDocGridIdentity) {
    let user = await this.prisma.user.findFirst({
      where: { identityProvider: PROVIDER, externalSubject: payload.sub },
      select: {
        id: true, email: true, name: true, role: true, plan: true, tariff: true, emailVerifiedAt: true,
        identityProvider: true, externalSubject: true, localLoginDisabled: true,
      },
    });

    if (!user) {
      const sameEmail = await this.prisma.user.findUnique({
        where: { email: payload.email },
        select: {
          id: true, email: true, name: true, role: true, plan: true, tariff: true, emailVerifiedAt: true,
          identityProvider: true, externalSubject: true, localLoginDisabled: true,
        },
      });
      if (sameEmail?.identityProvider && sameEmail.externalSubject !== payload.sub) {
        throw new UnauthorizedException('Identity e-mail is already linked to another subject');
      }

      if (sameEmail) {
        user = await this.prisma.user.update({
          where: { id: sameEmail.id },
          data: {
            identityProvider: PROVIDER,
            externalSubject: payload.sub,
            name: payload.name?.trim() || undefined,
            role: payload.role === 'ADMIN' ? UserRole.ADMIN : sameEmail.role,
            plan: payload.plan,
            tariff: payload.plan.toUpperCase(),
            emailVerifiedAt: sameEmail.emailVerifiedAt ?? new Date(),
            updatedAt: new Date(),
          },
          select: {
            id: true, email: true, name: true, role: true, plan: true, tariff: true, emailVerifiedAt: true,
            identityProvider: true, externalSubject: true, localLoginDisabled: true,
          },
        });
      } else {
        user = await this.prisma.user.create({
          data: {
            id: randomUUID(),
            email: payload.email,
            passwordHash: '!external-login-disabled',
            name: payload.name?.trim() || null,
            role: payload.role === 'ADMIN' ? UserRole.ADMIN : UserRole.USER,
            plan: payload.plan,
            tariff: payload.plan.toUpperCase(),
            identityProvider: PROVIDER,
            externalSubject: payload.sub,
            localLoginDisabled: true,
            emailVerifiedAt: new Date(),
            updatedAt: new Date(),
          },
          select: {
            id: true, email: true, name: true, role: true, plan: true, tariff: true, emailVerifiedAt: true,
            identityProvider: true, externalSubject: true, localLoginDisabled: true,
          },
        });
      }
    } else {
      if (user.email !== payload.email) {
        const collision = await this.prisma.user.findUnique({
          where: { email: payload.email },
          select: { id: true },
        });
        if (collision && collision.id !== user.id) {
          throw new UnauthorizedException('Identity e-mail conflicts with another account');
        }
      }

      const nextName = payload.name?.trim() || user.name;
      const nextRole = payload.role === 'ADMIN' ? UserRole.ADMIN : user.role;
      const changed =
        user.email !== payload.email ||
        user.name !== nextName ||
        user.role !== nextRole ||
        user.plan !== payload.plan ||
        user.tariff !== payload.plan.toUpperCase() ||
        !user.emailVerifiedAt;

      if (changed) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            email: payload.email,
            name: nextName,
            role: nextRole,
            plan: payload.plan,
            tariff: payload.plan.toUpperCase(),
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            updatedAt: new Date(),
          },
          select: {
            id: true, email: true, name: true, role: true, plan: true, tariff: true, emailVerifiedAt: true,
            identityProvider: true, externalSubject: true, localLoginDisabled: true,
          },
        });
      }
    }

    return user;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new UnauthorizedException('DocGrid access token required');
    let identity: TrustedDocGridIdentity;
    try { identity = verifyDocGridAccessToken(authorization.slice(7)); }
    catch { throw new UnauthorizedException('Invalid DocGrid identity token'); }
    if (identity.sub.length > 128 || identity.email.length > 320 || !identity.email.includes('@') || (identity.name && identity.name.length > 200)) throw new UnauthorizedException('Malformed identity');
    identity.email = identity.email.trim().toLowerCase();
    const user = await this.mirror(identity);

    request.user = {
      id: user.id,
      email: user.email,
      role: identity.role,
      plan: identity.plan,
      codexPlan: identity.plan,
      docgridAccess: identity.docgridAccess,
      externalSubject: identity.sub,
      identityProvider: PROVIDER,
    };
    return true;
  }
}
