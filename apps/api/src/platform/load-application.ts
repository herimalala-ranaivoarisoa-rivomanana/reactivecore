import { BadRequestException, Module } from '@nestjs/common';
import { pathToFileURL } from 'node:url';
import { ReactiveMutation } from '../mutation/reactive-mutation.decorator.js';
import { ReactiveQuery } from '../reactive/decorators/reactive-query.decorator.js';
import type { Project } from './project.js';

export type Application = Pick<Project, 'application' | 'functions'>;

export async function loadApplication(path: string): Promise<Application> {
  const { default: factory } = await import(pathToFileURL(path).href);
  if (typeof factory !== 'function')
    throw new Error('Expected an application factory');
  const application = factory({
    Module,
    ReactiveQuery,
    ReactiveMutation,
    BadRequestException,
  });
  if (
    typeof application?.application !== 'function' ||
    !application.functions?.queries ||
    !Array.isArray(application.functions.mutations)
  ) {
    throw new Error('Invalid application descriptor');
  }
  return application;
}
