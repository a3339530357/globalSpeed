import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

function load(path, imports, globals) {
	const source = readFileSync(resolve(import.meta.dirname, "../..", path), "utf8")
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	})
	const exports = {}
	runInNewContext(outputText, {
		exports,
		require(name) {
			if (!(name in imports)) throw new Error(`Missing import: ${name}`)
			return imports[name]
		},
		...globals,
	})
	return exports
}

function seekEnv() {
	class MediaStream {}
	class Media {
		srcObject = new MediaStream()
		// The MediaStream's own clock, which is not the decoder's position.
		currentTime = 0
	}
	class Core {
		_media = new Media()
		position = 10
		duration = 60
		seeks = []
		get currentTime() {
			return this.position
		}
		set currentTime(time) {
			this.position = time
			this.seeks.push(time)
		}
	}
	const roots = []
	const document = { querySelectorAll: () => roots }
	const { DouyinSeek } = load("src/contentScript/main/utils/DouyinSeek.ts", {}, { document, HTMLMediaElement: Media, MediaStream })
	const add = (core = new Core(), player = {}) => {
		const proxy = { _core: core, ...player }
		const root = { _player: { proxy }, contains: (media) => media === core._media }
		roots.push(root)
		return { core, root, proxy }
	}
	return { adapter: new DouyinSeek(), roots, add, Core }
}

test("a relative seek moves the decoder from its own position, not the element's clock", () => {
	const { adapter, add } = seekEnv()
	const { core } = add()
	core._media.currentTime = 999
	adapter.seek(0, 5, true)
	assert.equal(core.currentTime, 15)
	assert.equal(core._media.currentTime, 999, "the unseekable element must be left alone")
})

test("the player's own entry point is preferred and ends the attempts once it lands", () => {
	const { adapter, add } = seekEnv()
	const calls = []
	const { core } = add(undefined, {
		seek(time) {
			calls.push(time)
			this._core.position = time
		},
	})
	adapter.seek(0, 30, false)
	assert.deepEqual(calls, [30])
	assert.deepEqual(core.seeks, [], "no second jump once the decoder already moved")
	assert.equal(core.currentTime, 30)
})

test("an entry point that accepts the value without moving falls through to the next", () => {
	const { adapter, add } = seekEnv()
	const calls = []
	const { core } = add(undefined, { seek: (time) => calls.push(time) })
	adapter.seek(0, 30, false)
	assert.deepEqual(calls, [30])
	assert.deepEqual(core.seeks, [30], "the accessor must still be tried")
	assert.equal(core.currentTime, 30)
})

test("without a readable position the first accepted entry point is trusted", () => {
	const { adapter, add, Core } = seekEnv()
	const core = new Core()
	Object.defineProperty(core, "currentTime", { value: undefined, writable: true, configurable: true })
	const calls = []
	add(core, { seek: (time) => calls.push(time) })
	adapter.seek(0, 30, false)
	assert.deepEqual(calls, [30])
	assert.equal(core.currentTime, undefined, "an unverifiable seek must not be retried through the accessor")
})

test("a relative seek is abandoned when the decoder position cannot be read", () => {
	const { adapter, add, Core } = seekEnv()
	const core = new Core()
	Object.defineProperty(core, "currentTime", { value: NaN, writable: true, configurable: true })
	const calls = []
	add(core, { seek: (time) => calls.push(time) })
	adapter.seek(0, 5, true)
	assert.deepEqual(calls, [], "guessing an origin would jump somewhere arbitrary")
})

test("targets are clamped to the decoder's timeline", () => {
	const { adapter, add } = seekEnv()
	const { core } = add()
	adapter.seek(0, -999, true)
	assert.equal(core.currentTime, 0)
	adapter.seek(0, 999, false)
	assert.equal(core.currentTime, 60)
})

test("invalid offsets cannot move the decoder", () => {
	const { adapter, add } = seekEnv()
	const { core } = add()
	for (const bad of [NaN, Infinity, -Infinity, undefined, null, "5"]) adapter.seek(0, bad, true)
	assert.deepEqual(core.seeks, [])
	assert.equal(core.currentTime, 10)
})

test("native players, revoked proxies, and stale indexes are left alone", () => {
	const { adapter, add, roots } = seekEnv()
	const { core: native } = add()
	native._media.srcObject = null
	adapter.seek(0, 5, true)
	assert.deepEqual(native.seeks, [], "a native player still seeks through its element")

	const revoked = Proxy.revocable({}, {})
	revoked.revoke()
	roots.push({ _player: revoked })
	adapter.seek(1, 5, true)

	const { core: healthy } = add()
	adapter.seek(2, 5, true)
	assert.equal(healthy.currentTime, 15, "a broken neighbour must not disable a working player")

	adapter.seek(99, 5, true)
	adapter.seek(-1, 5, true)
})

test("a core without any usable entry point fails quietly", () => {
	const { adapter, add, Core } = seekEnv()
	const core = new Core()
	Object.defineProperty(core, "currentTime", { get: () => 10, configurable: true })
	add(core)
	adapter.seek(0, 5, true)
	assert.equal(core.currentTime, 10)
})

test("a player whose media moved out of its container is not sought", () => {
	const { adapter, add } = seekEnv()
	const { core, root } = add()
	root.contains = () => false
	adapter.seek(0, 5, true)
	assert.deepEqual(core.seeks, [])
})

test("only Douyin's MediaStream players are routed to the main world", () => {
	const roots = [{}, {}, {}]
	const document = { querySelectorAll: () => roots }
	const target = roots[1]
	const streamed = { srcObject: {}, closest: () => target }

	const { getDouyinSeekIndex } = load(
		"src/contentScript/isolated/utils/siteAdapters/douyin.ts",
		{},
		{ location: { hostname: "www.douyin.com" }, document },
	)
	assert.equal(getDouyinSeekIndex(streamed), 1)
	assert.equal(getDouyinSeekIndex({ srcObject: null, closest: () => target }), -1, "a native player seeks through the element")
	assert.equal(getDouyinSeekIndex({ srcObject: {}, closest: () => null }), -1)
	assert.equal(getDouyinSeekIndex(null), -1)

	const elsewhere = load("src/contentScript/isolated/utils/siteAdapters/douyin.ts", {}, { location: { hostname: "www.youtube.com" }, document })
	assert.equal(elsewhere.getDouyinSeekIndex(streamed), -1, "other sites must keep the native path")
})
