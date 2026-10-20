import { Body, Controller, Post, UseGuards, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DocGridIdentityGuard } from './docgrid-identity.guard';
import { AstraService } from './astra/astra.service';
import { AgentOAuthCodeStore } from './agent-oauth.controller';
import { config } from '../../config';
import { hash, seal, unseal } from '../../agent-transport';
import type { Consent } from '../../agent-oauth';
import { objectInput, assertKeys, stringInput, uuidInput } from './astra/astra.contracts';

// Only the existing account identity guard may enter this control plane.
// Agent tokens cannot create/approve grants or impersonate an account.
@UseGuards(DocGridIdentityGuard)
@Controller('api/docgrid/oauth/account')
export class AccountOAuthController {
  constructor(private readonly agents: AstraService, private readonly codes: AgentOAuthCodeStore) {}
  private readTicket(raw: unknown): Consent {
    if (config.DOCGRID_ACCOUNT_OAUTH_ENABLED !== "true") throw new BadRequestException("Account OAuth is not enabled");
    try {
      const ticket = stringInput(objectInput(raw), 'ticket', 8192);
      return unseal(config.DOCGRID_SERVICE_TOKEN, 'consent', ticket) as Consent;
    } catch { throw new BadRequestException('Authorization request expired. Restart connection.'); }
  }
  @Post('prepare')
  async prepare(@CurrentUser('id') user: string, @Body() raw: unknown) {
    const consent = this.readTicket(raw);
    const receipt = randomBytes(32).toString('base64url');
    const bindingHash = hash(user);
    await this.codes.save({ codeHash: hash(receipt), bindingHash, sealedToken: seal(config.DOCGRID_SERVICE_TOKEN, 'account-consent', { consent, user, exp: Date.now() + 120000 }) });
    const tools = this.agents.publicCatalog().tools.filter(t => !consent.scopes || consent.scopes.includes('docgrid') || consent.scopes.includes(t.name));
    return { receipt, clientName: consent.name, redirectOrigin: new URL(consent.redirect).origin, projectId: consent.projectId || null, tools, expiresIn: 120 };
  }
  @Post('decide')
  async decide(@CurrentUser('id') user: string, @Body() raw: unknown) {
    if (config.DOCGRID_ACCOUNT_OAUTH_ENABLED !== "true") throw new BadRequestException("Account OAuth is not enabled");
    const body = objectInput(raw);
    assertKeys(body, ['receipt', 'decision', 'projectId', 'actions']);
    const receipt = stringInput(body, 'receipt', 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(receipt)) throw new BadRequestException();
    const stored = await this.codes.consume({ codeHash: hash(receipt), bindingHash: hash(user) });
    const binding = unseal(config.DOCGRID_SERVICE_TOKEN, 'account-consent', stored.sealedToken);
    if (binding.user !== user) throw new UnauthorizedException();
    const consent: Consent = binding.consent;
    if (consent.exp <= Date.now()) throw new BadRequestException('Authorization request expired');
    const redirect = new URL(consent.redirect);
    redirect.searchParams.set('iss', `${config.DOCGRID_PUBLIC_ORIGIN}/api/docgrid/oauth`);
    if (consent.state) redirect.searchParams.set('state', consent.state);
    if (body.decision === 'deny') {
      redirect.searchParams.set('error', 'access_denied');
      return { redirectUrl: redirect.toString() };
    }
    if (body.decision !== 'allow') throw new BadRequestException();
    const projectId = uuidInput(body, 'projectId');
    if (consent.projectId && consent.projectId !== projectId) throw new BadRequestException('Project does not match request');
    const actions = body.actions;
    if (!Array.isArray(actions) || !actions.length || actions.some(a => typeof a !== 'string' || (consent.scopes && !consent.scopes.includes('docgrid') && !consent.scopes.includes(a)))) throw new BadRequestException('Invalid consent scopes');
    // Existing createGrant rechecks ownership and action validity transactionally,
    // stores a hashed credential and records the grant-created audit event.
    const expiry = Date.now() + 7 * 86400000;
    const created = await this.agents.createGrant(user, projectId, {
      requestKey: `oauth:${hash(receipt)}`, agentRef: `OAuth: ${consent.name}`.slice(0,120),
      actions, expiresAt: new Date(expiry).toISOString(), maxOperations: 10000,
    });
    if (!created.token) throw new BadRequestException('Restart authorization');
    const code = randomBytes(32).toString('base64url');
    try {
      const sealedToken = seal(config.DOCGRID_SERVICE_TOKEN, 'access', { grant: created.token, resource: consent.resource, projectId, clientId: consent.clientId, scopes: consent.scopes?.includes('docgrid') ? ['docgrid'] : actions, exp: expiry });
      const bindingHash = hash(JSON.stringify([consent.clientId, consent.redirect, consent.resource, consent.challenge]));
      await this.codes.save({ codeHash: hash(code), bindingHash, sealedToken });
    } catch (error) {
      await this.agents.revokeGrant(user, projectId, created.grant.id, {requestKey: `oauth-failed:${hash(receipt)}`});
      throw error;
    }
    redirect.searchParams.set('code', code);
    return { redirectUrl: redirect.toString() };
  }
}
