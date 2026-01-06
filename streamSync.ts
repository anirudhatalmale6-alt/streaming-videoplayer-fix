import { query } from "./database";
import { publish, setStreamState } from "./redis";

const SRS_API_URL = process.env.SRS_API_URL || "http://srs:1985";

interface SrsStream {
  id: string;
  name: string;
  vhost: string;
  app: string;
  url: string;
  publish: {
    active: boolean;
    cid: string;
  };
}

interface SrsStreamsResponse {
  code: number;
  streams: SrsStream[];
}

const knownActiveStreams = new Set<string>();

async function syncStreamStatus() {
  try {
    const response = await fetch(SRS_API_URL + "/api/v1/streams/");
    if (!response.ok) {
      console.error("Failed to fetch SRS streams:", response.statusText);
      return;
    }

    const data = await response.json() as SrsStreamsResponse;

    if (data.code !== 0) {
      console.error("SRS API error:", data);
      return;
    }

    const activeStreamKeys = new Set(
      data.streams
        .filter(s => s.publish?.active)
        .map(s => s.name.replace(".m3u8", ""))
    );

    for (const streamKey of activeStreamKeys) {
      if (!knownActiveStreams.has(streamKey)) {
        console.log("Stream sync: Detected new active stream " + streamKey);
        await handleStreamStart(streamKey);
        knownActiveStreams.add(streamKey);
      }
    }

    for (const streamKey of knownActiveStreams) {
      if (!activeStreamKeys.has(streamKey)) {
        console.log("Stream sync: Detected stream ended " + streamKey);
        await handleStreamEnd(streamKey);
        knownActiveStreams.delete(streamKey);
      }
    }
  } catch (error) {
    console.error("Stream sync error:", error);
  }
}

async function handleStreamStart(streamKey: string) {
  try {
    const result = await query(
      "UPDATE streams SET status = $2, actual_start = COALESCE(actual_start, NOW()), updated_at = NOW() WHERE stream_key = $1 AND status != $2 RETURNING id, user_id, title, recording_enabled",
      [streamKey, "live"]
    );

    if (result.rows.length > 0) {
      const stream = result.rows[0];

      await setStreamState(streamKey, {
        id: stream.id,
        status: "live",
        startTime: new Date().toISOString(),
        recordingEnabled: stream.recording_enabled
      });

      await publish("stream:start", {
        streamId: stream.id,
        streamKey,
        userId: stream.user_id,
        recordingEnabled: stream.recording_enabled
      });

      // Trigger recording if enabled
      if (stream.recording_enabled) {
        console.log("Stream sync: Starting recording for stream " + stream.id);
        await publish("recording:start", {
          streamId: stream.id,
          streamKey: streamKey,
          userId: stream.user_id,
          title: stream.title
        });
      }

      console.log("Stream sync: Stream " + stream.id + " marked as live");
    }
  } catch (error) {
    console.error("Stream sync error for " + streamKey + ":", error);
  }
}

async function handleStreamEnd(streamKey: string) {
  try {
    const result = await query(
      "UPDATE streams SET status = $2, actual_end = NOW(), updated_at = NOW() WHERE stream_key = $1 AND status = $3 RETURNING id",
      [streamKey, "ended", "live"]
    );

    if (result.rows.length > 0) {
      // Stop recording first
      await publish("recording:stop", {
        streamId: result.rows[0].id,
        streamKey: streamKey
      });

      await setStreamState(streamKey, null);
      await publish("stream:stop", {
        streamId: result.rows[0].id,
        streamKey
      });
      console.log("Stream sync: Stream " + result.rows[0].id + " marked as ended");
    }
  } catch (error) {
    console.error("Stream sync error for " + streamKey + ":", error);
  }
}

export function startStreamSync(intervalMs: number = 5000) {
  console.log("Starting stream sync service (interval: " + intervalMs + "ms)");
  syncStreamStatus();
  setInterval(syncStreamStatus, intervalMs);
}
