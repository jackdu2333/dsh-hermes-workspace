const test = require('node:test')
const assert = require('node:assert/strict')
const { makePanel, snapshot, deferred, settle } = require('./helpers.cjs')

test('late history cannot cross Bot boundaries, including switching away and back', async () => {
  const old = deferred()
  const panel = makePanel({
    resumeSession: () => old.promise,
    openBot: async ({ profile }) => snapshot(`session-${profile}`),
  })
  panel.render().applyResume(snapshot('session-alpha'), 'alpha')
  const pending = panel.render().refreshHistory()
  await panel.render().openBot({ name: 'beta' })
  old.resolve(snapshot('session-alpha'))
  assert.equal(await pending, false)
  assert.equal(panel.render().sessionId, 'session-beta')
  assert.equal(panel.render().activeProfile, 'beta')

  const again = deferred()
  const repeat = makePanel({
    resumeSession: () => again.promise,
    openBot: async ({ profile }) => snapshot(`session-${profile}`, 9),
  })
  repeat.render().applyResume(snapshot('session-alpha'), 'alpha')
  const stale = repeat.render().refreshHistory()
  await repeat.render().openBot({ name: 'beta' })
  await repeat.render().openBot({ name: 'alpha' })
  again.resolve(snapshot('session-alpha'))
  assert.equal(await stale, false)
  assert.equal(repeat.render().generationRef.current, 9)
})

test('latest Bot open wins when handshakes complete out of order', async () => {
  const first = deferred()
  const panel = makePanel({ openBot: ({ profile }) => profile === 'alpha' ? first.promise : Promise.resolve(snapshot('beta')) })
  const old = panel.render().openBot({ name: 'alpha' })
  await panel.render().openBot({ name: 'beta' })
  first.resolve(snapshot('alpha'))
  await old
  assert.equal(panel.render().activeProfile, 'beta')
  assert.equal(panel.render().sessionId, 'beta')
})

test('interrupt uses the current generation and ignores unrelated or older events', async () => {
  let sent
  const panel = makePanel({
    interruptSession: async request => { sent = request; return { accepted: true } },
  })
  panel.render().applyResume(snapshot(), 'alpha')
  panel.render().applyEvents([
    { type: 'message.start', session_id: 'chat', execution_generation: 8, payload: {} },
    { type: 'session.info', session_id: 'chat', execution_generation: 7, payload: { running: true } },
    { type: 'message.delta', session_id: 'other', execution_generation: 99, payload: { text: 'wrong chat' } },
  ])
  await panel.render().interrupt()
  assert.equal(sent.executionGeneration, 8)
  assert.equal(panel.render().liveRef.current.blocks.length, 0)
})

test('resume immediately restores pending cards', () => {
  const panel = makePanel({})
  panel.render().applyResume(snapshot('chat', 8, {
    openRequests: [{ id: 'srq-1', method: 'clarify', sessionId: 'chat', params: {}, receivedAt: 1 }],
  }), 'alpha')
  assert.equal(panel.render().requests.length, 1)
})

test('generation fencing preserves streamed text segmentation and duplicate suppression', () => {
  const panel = makePanel({})
  panel.render().applyResume(snapshot(), 'alpha')
  panel.render().applyEvents([
    { type: 'message.start', session_id: 'chat', execution_generation: 8, payload: {} },
    { type: 'message.delta', session_id: 'chat', execution_generation: 8, payload: { text: 'Before', segment: 0, offset: 0 } },
    { type: 'message.delta', session_id: 'chat', execution_generation: 8, payload: { text: 'Before', segment: 0, offset: 0 } },
    { type: 'tool.start', session_id: 'chat', execution_generation: 8, payload: { tool_id: 'tool', name: 'read_file' } },
    { type: 'message.delta', session_id: 'chat', execution_generation: 8, payload: { text: 'After', segment: 0, offset: 0 } },
    { type: 'tool.complete', session_id: 'chat', execution_generation: 8, payload: { tool_id: 'tool' } },
  ])
  const blocks = panel.render().liveRef.current.blocks
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].text, 'Before')
  assert.equal(blocks[1].status, 'done')
  assert.equal(blocks[2].text, 'After')
})

test('failed completion refresh preserves the visible draft', async () => {
  const panel = makePanel({ resumeSession: async () => { throw new Error('temporary failure') } })
  panel.render().applyResume(snapshot(), 'alpha')
  panel.render().applyEvents([
    { type: 'message.delta', session_id: 'chat', execution_generation: 8, payload: { text: 'keep me', offset: 0 } },
    { type: 'message.complete', session_id: 'chat', execution_generation: 8, payload: {} },
  ])
  await settle()
  assert.equal(panel.render().liveRef.current.blocks[0].text, 'keep me')
})

test('initial roster failure recovers online and retries even without another connection transition', async () => {
  let attempts = 0
  const panel = makePanel({
    getBotRoster: async () => {
      if (++attempts < 3) throw new Error('gateway warming up')
      return { profiles: [{ name: 'alpha', isDefault: true }] }
    },
    openBot: async () => snapshot(),
    getConnectionStatus: async () => ({ state: 'online', checkedAt: Date.now() }),
    getEvents: async () => ({ events: [], requests: [] }),
  })
  panel.render()
  const cleanup = panel.effects[0]()
  await settle()
  for (let index = 0; index < 4; index++) {
    panel.advance()
    panel.timers.shift()?.()
    await settle()
  }
  assert.equal(attempts, 3)
  assert.equal(panel.render().profiles.length, 1)
  assert.equal(panel.render().sessionId, 'chat')
  assert.equal(panel.render().error, null)
  cleanup()
})

test('old event poll cannot paint cards or stream content after a Bot switch', async () => {
  const old = deferred()
  const panel = makePanel({
    getBotRoster: async () => ({ profiles: [] }),
    getConnectionStatus: async () => ({ state: 'online', checkedAt: Date.now() }),
    getEvents: () => old.promise,
    resumeSession: async () => snapshot('alpha'),
    openBot: async () => snapshot('beta'),
  })
  panel.render().applyResume(snapshot('alpha'), 'alpha')
  const cleanup = panel.effects[0]()
  await settle()
  await panel.render().openBot({ name: 'beta' })
  old.resolve({
    events: [{ type: 'message.delta', payload: { text: 'old text' } }],
    requests: [{ id: 'old', method: 'approval', params: {}, receivedAt: 1 }],
  })
  await settle()
  assert.equal(panel.render().requests.length, 0)
  assert.equal(panel.render().liveRef.current.blocks.length, 0)
  assert.equal(panel.render().sessionId, 'beta')
  cleanup()
})
