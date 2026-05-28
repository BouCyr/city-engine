import {buildReplayPayload} from "./replay-service.mjs";

self.onmessage = (event) => {
  const {requestId, settingsData, stepIndex, inputMapData} = event.data ?? {};

  try {
    self.postMessage({
      requestId,
      status: "ready",
      replay: buildReplayPayload({settingsData, stepIndex, inputMapData}),
    });
  } catch (error) {
    self.postMessage({
      requestId,
      status: "error",
      error: error?.message ?? String(error),
    });
  }
};
