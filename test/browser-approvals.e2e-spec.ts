import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactService } from '../src/artifacts/artifact.service';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  ConfigurationService,
  loadConfiguration,
} from '../src/config/configuration';
import { DatabaseService } from '../src/persistence/database.service';
import { RunRepository } from '../src/persistence/run.repository';
import { ApprovalRepository } from '../src/persistence/approval.repository';
import { TemporalService } from '../src/temporal/temporal.service';
import { DispatchService } from '../src/temporal/dispatch.service';
import { ApiExceptionFilter } from '../src/common/errors/api-exception.filter';
import { MIGRATIONS } from '../src/persistence/migrate';

const PAYLOAD = 'a'.repeat(64);
const submitStep = {
  kind: 'submit',
  target: { kind: 'role', role: 'button', name: 'Send' },
  description: 'Send the support message',
};

describe('Approval API', () => {
  let app: INestApplication,
    pg: PGlite,
    runs: RunRepository,
    approvals: ApprovalRepository;
  const submitterA = 'tenant-a-submitter-'.repeat(3);
  const approverA = 'tenant-a-approver-'.repeat(3);
  const approverB = 'tenant-b-approver-'.repeat(3);
  const signal = jest.fn(async () => undefined);
  const cancel = jest.fn(async () => undefined);
  beforeAll(async () => {
    pg = new PGlite();
    for (const file of MIGRATIONS)
      await pg.exec(readFileSync('src/persistence/migrations/' + file, 'utf8'));
    const db = {
      query: async (text: string, values: unknown[] = []) =>
        (await pg.query(text, values)).rows,
    };
    // Tenant B's approver uses the same project id as tenant A.
    const config = new ConfigurationService(
      loadConfiguration('api', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        ARTIFACT_ROOT: mkdtempSync(join(tmpdir(), 'artifacts-')),
        AUTH_CREDENTIALS: JSON.stringify([
          {
            token: submitterA,
            tenantId: 'tenant-a',
            userId: 'submitter-a',
            projectIds: ['demo'],
            capabilities: ['browser'],
          },
          {
            token: approverA,
            tenantId: 'tenant-a',
            userId: 'approver-a',
            projectIds: ['demo'],
            capabilities: ['approve'],
          },
          {
            token: approverB,
            tenantId: 'tenant-b',
            userId: 'approver-b',
            projectIds: ['demo'],
            capabilities: ['approve'],
          },
        ]),
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigurationService)
      .useValue(config)
      .overrideProvider(DatabaseService)
      .useValue(db)
      .overrideProvider(TemporalService)
      .useValue({ cancel, signal, healthy: async () => true })
      .overrideProvider(DispatchService)
      .useValue({ enqueue: jest.fn(async () => undefined) })
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    runs = module.get(RunRepository);
    approvals = module.get(ApprovalRepository);
  }, 30000);
  afterAll(async () => {
    await app.close();
    await pg.close();
  });
  const http = () => request(app.getHttpServer());
  const as = (
    token: string,
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) => {
    const call = http()
      [method]('/projects/demo' + path)
      .set('authorization', 'Bearer ' + token);
    return body ? call.send(body) : call;
  };
  // A submitted run that the worker paused at its submit step.
  const waiting = async () => {
    const created = await http()
      .post('/projects/demo/browser-runs')
      .set('authorization', 'Bearer ' + submitterA)
      .set('idempotency-key', 'k-' + Math.random())
      .send({
        steps: [
          { kind: 'navigate', url: 'https://example.com/form' },
          submitStep,
        ],
      });
    expect(created.status).toBe(202);
    const run = await runs.get(created.body.runId, 'tenant-a', 'demo');
    await pg.query("UPDATE runs SET dispatch_state='DISPATCHED' WHERE id=$1", [
      run.id,
    ]);
    await runs.transition(run, 'RUNNING');
    await runs.transition(run, 'AWAITING_APPROVAL', {
      status: 'AWAITING_APPROVAL',
    });
    const approval = await approvals.request(
      run,
      1,
      {
        action: {
          kind: 'submit',
          description: submitStep.description,
          form: {
            action: 'https://example.com/send',
            method: 'POST',
            fields: [{ name: 'message', type: 'textarea' }],
          },
        },
        payloadHash: PAYLOAD,
        pageHash: 'b'.repeat(64),
        pageUrl: 'https://example.com/form',
      },
      600000,
    );
    return { runId: run.id, approvalId: approval.id };
  };

  test('a run accepts at most one consequential step', async () => {
    const response = await http()
      .post('/projects/demo/browser-runs')
      .set('authorization', 'Bearer ' + submitterA)
      .set('idempotency-key', 'k-' + Math.random())
      .send({ steps: [submitStep, submitStep] });
    expect(response.status).toBe(400);
  });

  test('inspect, approve and observe the outcome; the decision wakes the workflow', async () => {
    const { runId, approvalId } = await waiting();
    const list = await as(
      submitterA,
      'get',
      `/browser-runs/${runId}/approvals`,
    );
    expect(list.status).toBe(200);
    expect(list.body.approvals).toEqual([
      expect.objectContaining({
        approvalId,
        runId,
        step: 1,
        status: 'PENDING',
        payloadHash: PAYLOAD,
        requestedBy: 'submitter-a',
      }),
    ]);
    const run = await as(submitterA, 'get', `/browser-runs/${runId}`);
    expect(run.body.status).toBe('AWAITING_APPROVAL');
    const approved = await as(
      approverA,
      'post',
      `/approvals/${approvalId}/approve`,
      { payloadHash: PAYLOAD },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'approver-a',
    });
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ id: runId }),
      'approvalDecided',
    );
    // A duplicate approve is refused, not applied twice.
    const again = await as(
      approverA,
      'post',
      `/approvals/${approvalId}/approve`,
      { payloadHash: PAYLOAD },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('APPROVAL_APPROVED');
    const inspected = await as(submitterA, 'get', `/approvals/${approvalId}`);
    expect(inspected.body).toMatchObject({ status: 'APPROVED', outcome: null });
  });

  test('authorization: authentication, capability, tenant and payload binding', async () => {
    const { runId, approvalId } = await waiting();
    const path = `/approvals/${approvalId}/approve`;
    expect(
      (
        await http()
          .post('/projects/demo' + path)
          .send({ payloadHash: PAYLOAD })
      ).status,
    ).toBe(401);
    // The submitter has no approve capability (and could not approve its own run anyway).
    const self = await as(submitterA, 'post', path, { payloadHash: PAYLOAD });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CAPABILITY_DENIED');
    // Another tenant cannot find the approval or the run, even with the same project id.
    for (const call of [
      () => as(approverB, 'post', path, { payloadHash: PAYLOAD }),
      () => as(approverB, 'get', `/approvals/${approvalId}`),
      () => as(approverB, 'post', `/approvals/${approvalId}/cancel`, {}),
      () => as(approverB, 'get', `/browser-runs/${runId}/approvals`),
    ]) {
      const response = await call();
      expect(response.status).toBe(404);
    }
    const mismatch = await as(approverA, 'post', path, {
      payloadHash: 'c'.repeat(64),
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    expect((await as(approverA, 'post', path, {})).status).toBe(400);
    // A client-supplied scope in the body is not accepted.
    expect(
      (
        await as(approverA, 'post', path, {
          payloadHash: PAYLOAD,
          tenantId: 'tenant-a',
          runId,
        })
      ).status,
    ).toBe(400);
    const state = await as(submitterA, 'get', `/approvals/${approvalId}`);
    expect(state.body.status).toBe('PENDING');
  });

  test('reject and cancel; a cancelled run cancels its approval', async () => {
    const rejected = await waiting();
    const response = await as(
      approverA,
      'post',
      `/approvals/${rejected.approvalId}/reject`,
      { reason: 'not this one' },
    );
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'not this one',
    });
    const withdrawn = await waiting();
    const cancelled = await as(
      submitterA,
      'post',
      `/approvals/${withdrawn.approvalId}/cancel`,
      {},
    );
    expect(cancelled.body.status).toBe('CANCELLED');
    const runCancelled = await waiting();
    const runCancel = await as(
      submitterA,
      'post',
      `/browser-runs/${runCancelled.runId}/cancel`,
    );
    expect(runCancel.body).toEqual({ status: 'CANCELLED' });
    expect(cancel).toHaveBeenCalled();
    const after = await as(
      approverA,
      'post',
      `/approvals/${runCancelled.approvalId}/approve`,
      { payloadHash: PAYLOAD },
    );
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('APPROVAL_CANCELLED');
  });

  // Phase 6: stored artifacts follow the same tenant and project scoping.
  test('another tenant cannot fetch a run artifact, even with the same project id', async () => {
    const { runId } = await waiting();
    const run = await runs.get(runId, 'tenant-a', 'demo');
    const artifact = await app
      .get(ArtifactService)
      .save(run, Buffer.from('png-bytes'), 'image/png', 'p6-artifact');
    const own = await as(submitterA, 'get', '/artifacts/' + artifact.id);
    expect(own.status).toBe(200);
    expect(own.headers['content-disposition']).toBe('attachment');
    const foreign = await as(approverB, 'get', '/artifacts/' + artifact.id);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('png-bytes');
  });
});
