import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { secrets } from '../config/secrets';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  private static pool: Pool | null = null;
  private static db: NodePgDatabase<typeof schema> | null = null;

  constructor() {
    this.initializeConnection();
  }

  private initializeConnection(): void {
    if (DatabaseService.db) return;

    DatabaseService.pool = new Pool({ connectionString: secrets.DATABASE_URL });
    DatabaseService.db = drizzle(DatabaseService.pool, { schema });
    this.logger.log('Database singleton connection established');
  }

  get db(): NodePgDatabase<typeof schema> {
    return DatabaseService.db!;
  }

  async onModuleDestroy(): Promise<void> {
    if (DatabaseService.pool) {
      await DatabaseService.pool.end();
      DatabaseService.pool = null;
      DatabaseService.db = null;
      this.logger.log('Database connection pool closed');
    }
  }
}
