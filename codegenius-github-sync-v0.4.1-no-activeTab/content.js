(() => {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        !event.data || event.data.__cggh !== "event") return;
    const payload = event.data.payload;
    if (!payload || typeof payload !== "object") return;
    if (["submission", "submissionStart", "score", "debug", "questionDetail"].includes(payload.kind)) {
      chrome.runtime.sendMessage({ type: "CG_EVENT", payload }).catch(() => {});
    }
  });
  chrome.runtime.sendMessage({
    type: "CG_EVENT",
    payload: { kind: "debug", message: "콘텐츠 스크립트 연결됨", observedAt: Date.now() }
  }).catch(() => {});
})();