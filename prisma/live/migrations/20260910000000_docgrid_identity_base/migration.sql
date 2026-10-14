CREATE SCHEMA IF NOT EXISTS docgrid_live;
CREATE TYPE docgrid_live."UserRole" AS ENUM ('USER', 'ADMIN');
CREATE TABLE docgrid_live."User" (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, "passwordHash" TEXT NOT NULL,
 name TEXT, role docgrid_live."UserRole" NOT NULL DEFAULT 'USER',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 tariff TEXT NOT NULL DEFAULT 'FREE', plan TEXT NOT NULL DEFAULT 'free',
 "emailVerifiedAt" TIMESTAMP(3), "lastLoginAt" TIMESTAMP(3)
);
CREATE INDEX "User_emailVerifiedAt_idx" ON docgrid_live."User"("emailVerifiedAt");

