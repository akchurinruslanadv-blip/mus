// extensions/fetcher/tests/radio_loop_simulation.ts: Radio Continuous Transition Test
const sRes = await fetch("http://127.0.0.1:8787/api/radio/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
const sData = await sRes.json().catch(() => ({}));
if (!sRes.ok) {
  console.error(`Radio start HTTP error: ${sRes.status}`, sData);
}
console.log("--- START RADIO SIMULATION ---");
console.log(`Session: ${sData.session_id}`);
console.log(`Starting track: [ID: ${sData.current?.id}] ${sData.current?.artist} - ${sData.current?.title}`);
console.log(`Initial Queue Length: ${sData.queue?.length}`);

let curId = sData.current?.id;
let repeatCount = 0;
const history: { id: number; title: string }[] = [];
if (sData.current) history.push({ id: sData.current.id, title: sData.current.title });

for (let i = 1; i <= 15; i++) {
  const evRes = await fetch("http://127.0.0.1:8787/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "skip",
      session_id: sData.session_id,
      track_id: curId,
      position_sec: 5,
      duration_sec: 200,
      listened_sec: 5,
      reason: "skipped"
    })
  });
  const evData = await evRes.json().catch(() => ({}));
  if (!evRes.ok) {
    console.error(`Skip ${i} HTTP error: ${evRes.status}`, evData);
  }
  const nextTitle = evData.next?.title;
  const nextArtist = evData.next?.artist;
  const nextId = evData.next_id;
  console.log(`Skip ${i.toString().padStart(2)}: next_id=${nextId}, track="${nextArtist} - ${nextTitle}", queue_len=${evData.queue?.length}, ended=${evData.ended}`);

  if (!evData.next || nextId === 0) {
    console.error(`ERROR: Radio ended prematurely or returned null next at skip ${i}!`);
    repeatCount++;
  } else {
    // Check if repeated in last 4 tracks
    const recentSlice = history.slice(-4);
    if (recentSlice.some(h => h.id === nextId)) {
      console.error(`ERROR: Track repeated within last 4 steps at skip ${i}: [ID: ${nextId}] "${nextTitle}"!`);
      repeatCount++;
    }
  }

  history.push({ id: nextId, title: nextTitle });
  curId = nextId;
}

const nirvanaCount = history.filter(h => h.id === 1).length;
console.log("-----------------------------------------");
console.log(`Total Skips: 15, Failures/Repeats: ${repeatCount}, Nirvana Count: ${nirvanaCount} (out of 16 tracks played)`);
if (repeatCount === 0 && nirvanaCount <= 2) {
  console.log(">>> SUCCESS: Radio advances continuously across 15 skips with 0 stalls and 0 repetitive loops! <<<");
  Deno.exit(0);
} else {
  console.error(">>> FAILURE: Stalls, repeats, or Nirvana looping detected! <<<");
  Deno.exit(1);
}
