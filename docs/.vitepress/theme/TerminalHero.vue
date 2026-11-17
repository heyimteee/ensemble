<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue"
import { withBase } from "vitepress"
import "asciinema-player/dist/bundle/asciinema-player.css"

const props = defineProps({
  src: { type: String, required: true },
  poster: { type: String, required: true },
  posterAlt: { type: String, required: true },
  caption: { type: String, required: true },
  title: { type: String, default: "Ensemble terminal replay" },
})

const host = ref(null)
const posterVisible = ref(true)
const started = ref(false)
const failed = ref(false)
let player
let observer

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
}

async function start() {
  if (started.value || !host.value) return
  started.value = true
  try {
    const { create } = await import("asciinema-player")
    posterVisible.value = false
    player = create({ url: withBase(props.src) }, host.value, {
      autoPlay: true,
      loop: true,
      controls: true,
      fit: "width",
      terminalFontSize: "small",
      terminalFontFamily: "'DejaVu Sans Mono', 'Noto Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      idleTimeLimit: 2,
    })
  } catch {
    failed.value = true
    posterVisible.value = true
    started.value = false
  }
}

onMounted(() => {
  if (reducedMotion()) return
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect()
          observer = undefined
          void start()
        }
      },
      { threshold: 0.3 },
    )
    observer.observe(host.value)
  } else {
    void start()
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  player?.dispose?.()
})
</script>

<template>
  <figure class="terminal-hero">
    <div class="terminal-hero__frame">
      <div
        ref="host"
        class="terminal-hero__player"
        role="group"
        :aria-label="props.title"
      />
      <img
        v-if="posterVisible"
        class="terminal-hero__poster"
        :src="withBase(props.poster)"
        :alt="props.posterAlt"
        width="1100"
        height="680"
      />
      <button
        v-if="posterVisible"
        type="button"
        class="terminal-hero__play"
        @click="start"
      >
        {{ failed ? "Replay unavailable — showing the poster" : "Play the terminal replay" }}
      </button>
    </div>
    <figcaption>{{ props.caption }}</figcaption>
    <details class="terminal-hero__transcript">
      <summary>Text summary of the replay</summary>
      <ol>
        <li>The stable install command is shown at an isolated shell prompt.</li>
        <li>OpenCode starts and <code>/ensemble</code> opens the workspace.</li>
        <li>A group message is assigned to the leader, Ada.</li>
        <li>Work shows Ada's card as WORKING with its hop budget.</li>
        <li><code>o</code> opens Ada's native session, where the release note runs.</li>
      </ol>
      <p>
        The recording is a scripted replay of an isolated synthetic fixture.
        The install command is illustrative; the workspace, messages, Work
        card, and native session were captured from the local OpenCode host.
        Reduced-motion settings keep the poster visible until you press play.
      </p>
    </details>
  </figure>
</template>
