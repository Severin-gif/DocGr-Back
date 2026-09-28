import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { DocGridModule } from './modules/docgrid/docgrid.module';
import { HomeController } from './home.controller';
import { DocGridIdentityGuard } from './modules/docgrid/docgrid-identity.guard';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, DocGridModule],
  controllers: [HomeController], providers: [DocGridIdentityGuard] })
export class AppModule {}
