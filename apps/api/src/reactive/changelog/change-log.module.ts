import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ChangeLogService } from './change-log.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [ChangeLogService],
  exports: [ChangeLogService],
})
export class ChangeLogModule {}
