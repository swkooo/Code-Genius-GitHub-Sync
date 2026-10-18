(() => {
  if (window.__cgghHookInstalled) return;
  window.__cgghHookInstalled = true;

  const emit = (payload) => window.postMessage({ __cggh: "event", payload }, location.origin);
  emit({ kind: "debug", message: "페이지 요청 감지 훅 시작됨", observedAt: Date.now() });

  // Remember the site's own statistics request so we can re-query it after a submission,
  // rather than waiting for a page refresh/navigation to make the score appear.
  let lastStatisticsRequest = null;
  let statisticsPollInProgress = false;

  const isSubmitUrl = (url) => {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === "educodegenius.com" && /\/codingSubmit\/?$/.test(parsed.pathname);
    } catch (_) { return false; }
  };

  const isQuestionDetailUrl = (url) => {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === "educodegenius.com" &&
        /\/practice\/qitemBank\/detail\/r\/?$/.test(parsed.pathname);
    } catch (_) { return false; }
  };

  const parseBody = (body) => {
    if (!body) return null;
    if (typeof body === "string") {
      try { return JSON.parse(body); } catch (_) {
        try {
          const params = new URLSearchParams(body);
          const out = {};
          for (const [k, v] of params.entries()) out[k] = v;
          return Object.keys(out).length ? out : null;
        } catch (_) { return null; }
      }
    }
    if (body instanceof URLSearchParams || body instanceof FormData) {
      const out = {};
      for (const [k, v] of body.entries()) if (typeof v === "string") out[k] = v;
      return out;
    }
    return null;
  };

  const parseSubmissionParams = (body) => {
    if (!body) return null;
    // The site sends a form field named "param" whose value is itself JSON.
    if (typeof body.param === "string") {
      try { return JSON.parse(body.param); } catch (_) {}
    }
    return body;
  };

  const emitSubmitIfSuccess = (url, body, responseText, status, attemptId = null) => {
    if (!isSubmitUrl(url)) return;
    let json;
    try { json = JSON.parse(responseText); } catch (_) { json = null; }
    const params = parseSubmissionParams(body);
    emit({
      kind: "debug",
      message: `codingSubmit 응답 관찰: HTTP ${status}, bodyKeys=${body ? Object.keys(body).join(",") : "본문 파싱 실패"}, paramParsed=${!!(params && params.sourcecode)}`,
      observedAt: Date.now()
    });
    if (params && params.sourcecode && json && json.result === true && String(json.code || "") === "100") {
      emit({
        kind: "submission",
        sourcecode: params.sourcecode,
        attemptId,
        language: params.language || "",
        practiceId: String(params.prctcExmplSn || "").trim(),
        qitemId: String(params.prctcExmplQitemsSn || "").trim(),
        qitemVersion: String(params.qitemVersion || ""),
        solveBgngTime: params.solveBgngTime || "",
        solveEndTime: params.solveEndTime || "",
        observedAt: Date.now()
      });
      // The site often refreshes statistics only on navigation. Poll its observed endpoint
      // after the successful submission response so an upload can happen on the same page.
      void pollStatisticsAfterSubmission(String(params.prctcExmplQitemsSn || "").trim(), attemptId);
    } else {
      emit({ kind: "debug", message: "제출 URL은 감지했지만 param 내부 코드 또는 성공 응답을 확인하지 못함", observedAt: Date.now() });
    }
  };

  const replayStatisticsRequest = async () => {
    const saved = lastStatisticsRequest;
    if (!saved) return null;
    const init = {
      method: saved.method || "GET",
      credentials: "include",
      headers: saved.headers
    };
    if (init.method.toUpperCase() !== "GET" && init.method.toUpperCase() !== "HEAD" && saved.body != null) {
      init.body = saved.body;
    }
    const response = await originalFetch(saved.url, init);
    const text = await response.clone().text();
    await inspectResponse(response.url || saved.url, saved.body, text, response.status);
    return text;
  };

  const pollStatisticsAfterSubmission = async (qitemId, attemptId) => {
    if (statisticsPollInProgress) return;
    statisticsPollInProgress = true;
    try {
      if (!lastStatisticsRequest) {
        emit({ kind: "debug", message: "제출은 성공했지만 statistics 요청 정보가 아직 없어 점수 재조회는 건너뜁니다.", observedAt: Date.now() });
        return;
      }
      emit({ kind: "debug", message: `제출 성공 후 문제 ${qitemId} 채점 통계를 재조회합니다.`, observedAt: Date.now() });
      for (let i = 0; i < 15; i++) {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const text = await replayStatisticsRequest();
          let json;
          try { json = JSON.parse(text || ""); } catch (_) { json = null; }
          const stats = json?.object?.statistics || json?.statistics;
          const score = stats?.markChek ?? stats?.memMarkChek;
          const responseQitemId = stats?.prctcExmplQitemsSn;
          if (stats && String(responseQitemId ?? qitemId) === String(qitemId) && score != null && String(score) !== "") {
            const observedAt = Date.now();
            emit({ kind: "debug", message: `제출 후 채점 통계 확인: 문제 ${qitemId}, 점수 ${score}, 제출 시도 ${attemptId || "ID 없음"}`, observedAt });
            // Send a score event explicitly tied to this exact submission attempt.
            // The generic score event emitted by inspectResponse can be deduplicated
            // against the page's ordinary statistics request, so it must not be the
            // only signal used to trigger the upload.
            emit({
              kind: "score",
              score: String(score),
              qitemId: String(qitemId),
              submissionCount: stats.sbmsnCnt == null ? null : Number(stats.sbmsnCnt),
              attemptId: attemptId || null,
              correlatedSubmission: true,
              observedAt
            });
            break;
          }
        } catch (error) {
          emit({ kind: "debug", message: `제출 후 statistics 재조회 ${i + 1}/15 실패: ${String(error)}`, observedAt: Date.now() });
        }
      }
    } finally {
      statisticsPollInProgress = false;
    }
  };

  const getStatisticsScore = (url, obj) => {
    let parsed;
    try { parsed = new URL(url, location.href); } catch (_) { return null; }
    if (parsed.pathname.replace(/\/+$/, "") !== "/practice/statistics") return null;

    const stats = obj?.object?.statistics || obj?.statistics;
    if (!stats || (stats.memMarkChek == null && stats.markChek == null)) return null;

    return {
      kind: "score",
      score: String(stats.markChek ?? stats.memMarkChek),
      qitemId: stats.prctcExmplQitemsSn == null ? null : String(stats.prctcExmplQitemsSn).trim(),
      submissionCount: stats.sbmsnCnt == null ? null : Number(stats.sbmsnCnt),
      observedAt: Date.now()
    };
  };

  const inspectResponse = async (url, body, responseText, status, attemptId = null) => {
    emitSubmitIfSuccess(url, body, responseText, status, attemptId);
    let json;
    try { json = JSON.parse(responseText); } catch (_) { json = null; }
    if (json && /educodegenius\.com/.test(location.hostname)) {
      let responsePath = "";
      try { responsePath = new URL(url, location.href).pathname.replace(/\/+$/, ""); } catch (_) {}
      if (responsePath === "/practice/qitemBank/detail/r" && json.result === true && json.object?.data) {
        const d = json.object.data;
        emit({
          kind: "questionDetail",
          qitemId: String(d.prctcExmplQitemsSn ?? "").trim(),
          title: d.qitemTtl || "",
          statement: d.qitemCn || "",
          constraints: d.lmtMttrCn || "",
          inputDescription: d.inptCn || "",
          outputDescription: d.otptCn || "",
          sampleInput1: d.exmplInpt1 || "",
          sampleOutput1: d.exmplOtpt1 || "",
          sampleInput2: d.exmplInpt2 || "",
          sampleOutput2: d.exmplOtpt2 || "",
          observedAt: Date.now()
        });
      }
      if (responsePath === "/practice/statistics") {
        const stats = json.object?.statistics || json.statistics || {};
        emit({
          kind: "debug",
          message: `statistics 응답 감지: 문제 ${stats.prctcExmplQitemsSn ?? "ID 없음"}, memMarkChek=${stats.memMarkChek ?? "없음"}, sbmsnCnt=${stats.sbmsnCnt ?? "없음"}`,
          observedAt: Date.now()
        });
      }
      const scoreEvent = getStatisticsScore(url, json);
      if (scoreEvent) {
        emit({ kind: "debug", message: `점수 이벤트 전송: 문제 ${scoreEvent.qitemId ?? "ID 없음"}, 점수 ${scoreEvent.score}, 제출 횟수 ${scoreEvent.submissionCount ?? "없음"}`, observedAt: Date.now() });
        emit(scoreEvent);
      }
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/\/practice\/statistics\/?(?:\?|$)/.test(url)) {
      let savedBody = init?.body ?? null;
      if (savedBody == null && input instanceof Request && !["GET", "HEAD"].includes(input.method.toUpperCase())) {
        try { savedBody = await input.clone().text(); } catch (_) {}
      }
      lastStatisticsRequest = {
        url,
        method: init?.method || (input instanceof Request ? input.method : "GET"),
        body: savedBody,
        headers: init?.headers || (input instanceof Request ? input.headers : undefined)
      };
    }
    let body = isSubmitUrl(url) ? parseBody(init && init.body) : null;
    if (isSubmitUrl(url) && !body && input instanceof Request) {
      try { body = parseBody(await input.clone().text()); } catch (_) {}
    }
    const response = await originalFetch.apply(this, arguments);
    try {
      const actualUrl = response.url || url;
      if (/\/practice\/statistics\/?(?:\?|$)/.test(actualUrl)) {
        emit({ kind: "debug", message: `statistics 요청 응답 포착 (fetch, HTTP ${response.status})`, observedAt: Date.now() });
      }
      const text = await response.clone().text();
      await inspectResponse(actualUrl, body, text, response.status);
    } catch (e) {
      emit({ kind: "debug", message: `fetch 응답 분석 오류: ${String(e)}`, observedAt: Date.now() });
    }
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  const open = OriginalXHR.prototype.open;
  const send = OriginalXHR.prototype.send;
  OriginalXHR.prototype.open = function(method, url) {
    this.__cgghUrl = url;
    this.__cgghMethod = method;
    this.__cgghHeaders = {};
    return open.apply(this, arguments);
  };
  const setRequestHeader = OriginalXHR.prototype.setRequestHeader;
  OriginalXHR.prototype.setRequestHeader = function(name, value) {
    if (this.__cgghHeaders) this.__cgghHeaders[name] = value;
    return setRequestHeader.apply(this, arguments);
  };
  OriginalXHR.prototype.send = function(body) {
    const url = this.__cgghUrl || "";
    if (/\/practice\/statistics\/?(?:\?|$)/.test(url)) {
      lastStatisticsRequest = {
        url: new URL(url, location.href).href,
        method: this.__cgghMethod || "GET",
        body: body ?? null,
        headers: { ...(this.__cgghHeaders || {}) }
      };
    }
    const parsedBody = isSubmitUrl(url) ? parseBody(body) : null;
    const submitParams = isSubmitUrl(url) ? parseSubmissionParams(parsedBody) : null;
    const attemptId = isSubmitUrl(url) ? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}` : null;
    if (isSubmitUrl(url)) {
      emit({ kind: "debug", message: `codingSubmit 요청 감지 (${this.__cgghMethod || "?"}), body=${parsedBody ? Object.keys(parsedBody).join(",") : "파싱 실패"}`, observedAt: Date.now() });
      if (submitParams?.sourcecode && submitParams?.prctcExmplQitemsSn) {
        emit({
          kind: "submissionStart",
          attemptId,
          sourcecode: submitParams.sourcecode,
          language: submitParams.language || "",
          practiceId: String(submitParams.prctcExmplSn || "").trim(),
          qitemId: String(submitParams.prctcExmplQitemsSn || "").trim(),
          qitemVersion: String(submitParams.qitemVersion || ""),
          solveBgngTime: submitParams.solveBgngTime || "",
          solveEndTime: submitParams.solveEndTime || "",
          observedAt: Date.now()
        });
      }
    }
    this.addEventListener("load", function() {
      try {
        const actualUrl = this.responseURL || url;
        if (/\/practice\/statistics\/?(?:\?|$)/.test(actualUrl)) {
          emit({ kind: "debug", message: `statistics 요청 응답 포착 (XHR, HTTP ${this.status})`, observedAt: Date.now() });
        }
        inspectResponse(actualUrl, parsedBody, this.responseText, this.status, attemptId);
      } catch (e) {
        emit({ kind: "debug", message: `XHR 응답 분석 오류: ${String(e)}`, observedAt: Date.now() });
      }
    });
    return send.apply(this, arguments);
  };
})();