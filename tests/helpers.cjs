const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

// 在内存中编译项目源码，不导入宿主、不连接真实 Gateway。
function loadSource(relative, overrides = {}, transform = source => source, globals = {}) {
  const filename = path.join(root, relative)
  const code = ts.transpileModule(transform(fs.readFileSync(filename, 'utf8')), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, console, Buffer, URL, URLSearchParams, process,
    setTimeout, clearTimeout, WebSocket,
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) {
        const absolute = path.resolve(path.dirname(filename), name)
        const found = ['.ts', '.tsx'].map(ext => absolute + ext).find(file => fs.existsSync(file))
        if (found) return loadSource(path.relative(root, found), overrides).exports
      }
      return require(name)
    },
    ...globals,
  })
  vm.runInContext(code, context, { filename })
  return { exports: module.exports, context }
}

const schema = {
  object: () => ({}),
  string: () => ({ default() { return this }, description() { return this } }),
}

function makeService(transport) {
  const { HermesBridgeService } = loadSource('src/host/HermesBridgeService.ts', {
    '@deepseek-ai/schemastery': schema,
    '@deepseek-ai/dsh-typert-protocol': { TypertRemoteService: class {}, Remote: () => () => {} },
  }).exports
  const service = Object.create(HermesBridgeService.prototype)
  service.defaultProfile = 'alpha'
  service.transports = new Map([['alpha', transport]])
  return service
}

function makeTransport() {
  const { GatewayTransport } = loadSource('src/host/gatewayRemote.ts').exports
  const sent = []
  const socket = {
    readyState: WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)) },
    close() {},
  }
  const transport = new GatewayTransport({ profile: 'alpha' })
  transport.ws = socket
  transport.state = 'online'
  transport.bindMessages(socket)
  return {
    transport, sent, socket,
    frame(frame) { socket.onmessage({ data: JSON.stringify(frame) }) },
    event(type, payload = {}, generation = 8, session = 'chat') {
      this.frame({ jsonrpc: '2.0', method: 'event', params: {
        type, session_id: session, execution_generation: generation, payload,
      } })
    },
  }
}

function makePanel(api) {
  const slots = []
  const effects = []
  const timers = []
  let cursor = 0
  let now = Date.now()
  const react = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, next => {
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(callback) {
      const index = cursor++
      if (!slots[index]) { slots[index] = {}; effects.push(callback) }
    },
  }
  const anchor = "  const state = status?.state ?? 'disconnected'"
  const loaded = loadSource('src/client/index.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
  }, source => {
    if (!source.includes(anchor)) throw new Error('Panel test instrumentation needs updating')
    return source.replace(anchor, `globalThis.__panel = {
      applyResume, refreshHistory, openBot, applyEvents, interrupt, send, setDraft, respond,
      sessionRef, profileRef, generationRef, liveRef,
      sessionId, activeProfile, messages, requests, profiles, error, status,
    };\n${anchor}`) + '\nexport { HermesChatPanel }\n'
  }, {
    Date: class extends Date { static now() { return now } },
    window: { setTimeout(callback) { timers.push(callback); return timers.length } },
  })
  return {
    effects, timers,
    advance(ms = 1300) { now += ms },
    render() { cursor = 0; loaded.exports.HermesChatPanel({ api }); return loaded.context.__panel },
  }
}

function snapshot(sessionId = 'chat', generation = 7, extra = {}) {
  return {
    sessionId, messages: [{ id: sessionId, role: 'assistant', text: `history:${sessionId}` }],
    messageCount: 1, running: false, openRequests: [], executionGeneration: generation, ...extra,
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

module.exports = { loadSource, makeService, makeTransport, makePanel, snapshot, deferred, settle }
