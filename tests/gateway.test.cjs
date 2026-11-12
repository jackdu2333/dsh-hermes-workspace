const test = require('node:test')
const assert = require('node:assert/strict')
const { makeService, makeTransport, settle } = require('./helpers.cjs')

test('canonical approval/clarify events become answerable cards and retain their generation', async () => {
  const fixture = makeTransport()
  fixture.event('approval.request', { prompt_id: 'approve', choices: ['once', 'deny'], command: 'echo fixture' })
  fixture.event('clarify.request', { prompt_id: 'question', question: 'Pick one', choices: ['A', 'B'] })
  const page = await makeService(fixture.transport).getEvents({ profile: 'alpha' })
  assert.equal(page.events.length, 2)
  assert.equal(page.requests.length, 2)
  assert.equal(page.requests[0].executionGeneration, 8)
  assert.equal(page.requests[1].params.questions[0].qid, 'question')

  const approval = fixture.transport.respond('approve', { choice: 'once' })
  await settle()
  const sent = fixture.sent.at(-1)
  assert.equal(sent.method, 'approval.respond')
  assert.deepEqual(sent.params, { session_id: 'chat', prompt_id: 'approve', execution_generation: 8, choice: 'once' })
  fixture.frame({ id: sent.id, result: { status: 'resolved' } })
  await approval

  const clarify = fixture.transport.respond('question', { answers: { question: 'B' }, outcome: 'submitted' })
  await settle()
  const answer = fixture.sent.at(-1)
  assert.equal(answer.method, 'clarify.respond')
  assert.equal(answer.params.answer, 'B')
  fixture.frame({ id: answer.id, result: { status: 'resolved' } })
  await clarify
  assert.equal(fixture.transport.listRequests().length, 0)
})

test('reverse RPC answers retain the original id and canonical invalid choices fail closed', async () => {
  const fixture = makeTransport()
  fixture.frame({ id: 42, method: 'approval', params: { session_id: 'chat', choices: ['once', 'deny'] } })
  await fixture.transport.respond('42', { choice: 'deny' })
  assert.equal(fixture.sent[0].id, 42)
  assert.deepEqual(fixture.sent[0].result, { choice: 'deny' })
  fixture.event('approval.request', { kind: 'approval', prompt_id: 'guarded', choices: ['deny'] })
  await assert.rejects(fixture.transport.respond('guarded', { choice: 'always' }), /允许的范围/)
  assert.equal(fixture.transport.listRequests().length, 1)
})

test('resume restores both protocols into the transport queue and panel DTO', async () => {
  const fixture = makeTransport()
  const service = makeService(fixture.transport)
  const pending = service.resumeSession({ sessionId: 'chat', profile: 'alpha' })
  await settle()
  fixture.frame({ id: fixture.sent.at(-1).id, result: {
    session_id: 'chat', execution_generation: 8, messages: [],
    prompts: [{ kind: 'approval', prompt_id: 'approve', choices: ['once', 'deny'], execution_generation: 8 }],
    open_requests: [{ id: 'srq-restore', method: 'clarify', params: {
      questions: [{ qid: 'q1', question: 'Restore?', choices: ['yes'] }], answers: { q1: 'yes' },
    } }],
  } })
  const result = await pending
  assert.equal(result.openRequests.length, 2)
  assert.equal(fixture.transport.listRequests().length, 2)
  const request = fixture.transport.listRequests().find(item => item.id === 'srq-restore')
  assert.equal(request.params.answers.q1, 'yes')
  await fixture.transport.respond('srq-restore', { answers: { q1: 'yes' } })
  assert.equal(fixture.sent.at(-1).id, 'srq-restore')
})

test('late resume cannot resurrect requests cancelled while the snapshot was in flight', async () => {
  const fixture = makeTransport()
  const pending = fixture.transport.rpc('session.resume', { session_id: 'chat' })
  await settle()
  fixture.event('approval.settled', { prompt_id: 'gone', execution_generation: 8 })
  fixture.event('request.cancel', { id: 'srq-gone' })
  fixture.frame({ id: fixture.sent.at(-1).id, result: {
    session_id: 'chat', execution_generation: 8,
    prompts: [{ kind: 'approval', prompt_id: 'gone', choices: ['once'], execution_generation: 8 }],
    open_requests: [{ id: 'srq-gone', method: 'clarify', params: {} }],
  } })
  await pending
  assert.equal(fixture.transport.listRequests().length, 0)
})

test('snapshot reconciliation retains newer live cards and removes settled snapshot cards', async () => {
  const fixture = makeTransport()
  fixture.event('approval.request', { prompt_id: 'expired', choices: ['once'] })
  const pending = fixture.transport.rpc('session.resume', { session_id: 'chat' })
  await settle()
  fixture.event('clarify.request', { prompt_id: 'new', question: 'New question' })
  fixture.frame({ id: fixture.sent.at(-1).id, result: { session_id: 'chat', prompts: [], open_requests: [] } })
  await pending
  assert.deepEqual(Array.from(fixture.transport.listRequests(), item => item.id), ['new'])
  fixture.socket.onclose()
  assert.equal(fixture.transport.listRequests().length, 0)
})
