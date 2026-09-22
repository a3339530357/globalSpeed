export const IS_DOUYIN = location.hostname === "douyin.com" || location.hostname.endsWith(".douyin.com")

export type DouyinSpeedMessage = { type: "DOUYIN_SPEED"; speed: number | null }
export type DouyinSeekMessage = { type: "DOUYIN_SEEK"; index: number; value: number; relative?: boolean }

const PLAYER_SELECTOR = ".douyin-player"

/**
 * Douyin's WebCodecs player feeds a MediaStream into the video, and a MediaStream has no
 * seekable timeline, so writing video.currentTime is silently discarded. The decoder's
 * position lives on the same main-world core that owns playbackRate, which only the main
 * world can reach. Returns the index of the owning player container so that world can
 * resolve the same element, or -1 when the ordinary native path still applies.
 *
 * Expando keys do not cross worlds, so the container's position in the document is the
 * identity both sides share. The message is dispatched synchronously, leaving no gap in
 * which the list could change, and the main world revalidates whatever it resolves.
 */
export function getDouyinSeekIndex(elem: HTMLMediaElement) {
	if (!IS_DOUYIN || !elem?.srcObject) return -1
	const root = elem.closest?.(PLAYER_SELECTOR)
	if (!root) return -1
	return [...document.querySelectorAll(PLAYER_SELECTOR)].indexOf(root)
}
