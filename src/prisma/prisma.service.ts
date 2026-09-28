import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    try { await this.$connect(); }
    catch (error) { const e = error as { name?: string; errorCode?: string }; new Logger('DocGridDatabase').error(`Database unavailable (${e.name || 'unknown'} ${e.errorCode || ''}); /ready will return 503`); }
  }
  async onModuleDestroy() { await this.$disconnect(); }
}
