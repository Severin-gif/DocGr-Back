import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { objectInput, assertKeys, stringInput } from './astra/astra.contracts';

@Injectable()
export class AgentOAuthCodeStore {
  constructor(private readonly prisma: PrismaService) {}
  async save(raw: unknown) {
    const body = objectInput(raw);
    assertKeys(body, ['codeHash', 'bindingHash', 'sealedToken']);
    const codeHash = stringInput(body, 'codeHash', 64), bindingHash = stringInput(body, 'bindingHash', 64), sealedToken = stringInput(body, 'sealedToken', 8192);
    if (!/^[a-f0-9]{64}$/.test(codeHash) || !/^[a-f0-9]{64}$/.test(bindingHash)) throw new UnauthorizedException();
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`DELETE FROM docgrid.dg_agent_oauth_codes WHERE expires_at < now()`;
      await tx.$executeRaw`INSERT INTO docgrid.dg_agent_oauth_codes(code_hash,binding_hash,sealed_token,expires_at) VALUES (${codeHash},${bindingHash},${sealedToken},now()+interval '120 seconds')`;
    });
    return { saved: true };
  }
  async consume(raw: unknown) {
    const body = objectInput(raw);
    assertKeys(body, ['codeHash', 'bindingHash']);
    const codeHash = stringInput(body, 'codeHash', 64), bindingHash = stringInput(body, 'bindingHash', 64);
    const rows = await this.prisma.$queryRaw<{ sealedToken: string }[]>`DELETE FROM docgrid.dg_agent_oauth_codes WHERE code_hash=${codeHash} AND binding_hash=${bindingHash} AND expires_at>now() RETURNING sealed_token AS "sealedToken"`;
    if (!rows.length) throw new UnauthorizedException('Invalid or consumed authorization code');
    return rows[0];
  }
}

