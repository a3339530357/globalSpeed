type DouyinCore = {
	_media: HTMLMediaElement
	currentTime?: number
	duration?: number
	seek?: (time: number) => void
}
type DouyinPlayer = { _core?: DouyinCore; seek?: (time: number) => void }
type DouyinRoot = HTMLElement & { _player?: { proxy?: DouyinPlayer } }

const PLAYER_SELECTOR = ".douyin-player"

/** Treat the decoder as having moved once it is within a frame or so of the request. */
const LANDED_TOLERANCE = 0.5

function findDescriptor(target: object, key: string): PropertyDescriptor | undefined {
	let level: object = target
	while (level) {
		const descriptor = Object.getOwnPropertyDescriptor(level, key)
		if (descriptor) return descriptor
		level = Object.getPrototypeOf(level)
	}
}

function readNumber(core: DouyinCore, descriptor: PropertyDescriptor | undefined) {
	if (!descriptor) return
	const value = descriptor.get ? descriptor.get.call(core) : descriptor.value
	return Number.isFinite(value) ? (value as number) : undefined
}

// Douyin's WebCodecs player feeds a MediaStream into the video. A MediaStream has no
// seekable timeline, so video.currentTime is read-only in practice and every seek the
// extension writes is silently dropped. The real position lives on the same main-world
// core that owns playbackRate (see DouyinSpeed), so seeks have to go through it.
//
// Which member actually drives that core is not documented and has changed with the
// player, so try the plausible entry points in turn and keep the first one that moves
// the decoder. Relative seeks are resolved here rather than in the isolated world,
// whose view of currentTime belongs to the MediaStream and is not the real position.
export class DouyinSeek {
	seek = (index: number, value: number, relative: boolean) => {
		if (!Number.isFinite(value) || !(index >= 0)) return

		const root = this.resolveRoot(index)
		const core = this.resolveCore(root)
		if (!core) return

		const descriptor = findDescriptor(core, "currentTime")
		const current = readNumber(core, descriptor)
		// A relative seek without a trustworthy origin would jump somewhere arbitrary.
		if (relative && current === undefined) return

		let target = relative ? current + value : value
		if (!Number.isFinite(target)) return
		target = Math.max(0, target)

		const duration = readNumber(core, findDescriptor(core, "duration"))
		if (duration > 0) target = Math.min(target, duration)

		const player = root._player?.proxy
		const attempts = [
			// The player's own entry point, which also moves the site's progress bar.
			() => this.call(player?.seek, player, target),
			() => this.write(core, descriptor, target),
			() => this.call(core.seek, core, target),
		]

		for (const attempt of attempts) {
			let attempted = false
			try {
				attempted = attempt()
			} catch {
				// A destroyed or unsupported entry point must not block the remaining ones.
			}
			if (!attempted) continue
			// Without a readable position there is nothing to verify against, so trust
			// the first entry point that accepted the value rather than seeking twice.
			if (current === undefined) return
			if (this.landed(core, descriptor, target)) return
		}
	}

	private call(method: unknown, self: unknown, target: number) {
		if (typeof method !== "function") return false
		method.call(self, target)
		return true
	}

	private write(core: DouyinCore, descriptor: PropertyDescriptor | undefined, target: number) {
		if (descriptor?.set) {
			descriptor.set.call(core, target)
			return true
		}
		// A plain data property still counts, but an accessor without a setter does not.
		if (!descriptor || descriptor.get || !descriptor.writable) return false
		core.currentTime = target
		return true
	}

	private landed(core: DouyinCore, descriptor: PropertyDescriptor | undefined, target: number) {
		const now = readNumber(core, descriptor)
		return now !== undefined && Math.abs(now - target) <= LANDED_TOLERANCE
	}

	private resolveRoot(index: number): DouyinRoot | undefined {
		return document.querySelectorAll<DouyinRoot>(PLAYER_SELECTOR)[index]
	}

	private resolveCore(root: DouyinRoot | undefined): DouyinCore | undefined {
		if (!root) return
		try {
			// _player is a revocable proxy and may already have been destroyed.
			const core = root._player?.proxy?._core
			const media = core?._media
			if (!(media instanceof HTMLMediaElement) || !root.contains(media)) return
			// Only the MediaStream players need this path; the rest seek natively.
			if (typeof MediaStream === "undefined" || !(media.srcObject instanceof MediaStream)) return
			return core
		} catch {}
	}
}
