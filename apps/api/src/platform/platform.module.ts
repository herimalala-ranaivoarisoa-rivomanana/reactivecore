import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { MutationModule } from '../mutation/mutation.module.js';
import { ReactiveModule } from '../reactive/reactive.module.js';
import { PlatformController } from './platform.controller.js';
import { ProjectAuthGuard } from './project-auth.guard.js';
import { PROJECT, type Project } from './project.js';

@Module({})
export class PlatformModule {
  static forProject(project: Project): DynamicModule {
    if (!project.issuer || !project.audience)
      throw new Error('Project issuer and audience are required');
    return {
      module: PlatformModule,
      imports: [
        HealthModule,
        MutationModule,
        ReactiveModule,
        project.application,
      ],
      controllers: [PlatformController],
      providers: [ProjectAuthGuard, { provide: PROJECT, useValue: project }],
    };
  }
}
