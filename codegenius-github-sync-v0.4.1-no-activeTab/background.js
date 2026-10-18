
const SETTINGS_WINDOW_URL = chrome.runtime.getURL("popup.html");
async function openSettingsWindow() {
  const existing = await chrome.windows.getAll({ populate: true });
  const settingsUrl = SETTINGS_WINDOW_URL;
  const match = existing.find(w => (w.tabs || []).some(t => t.url === settingsUrl));
  if (match) { await chrome.windows.update(match.id, { focused: true }); return; }
  await chrome.windows.create({ url: settingsUrl, type: "popup", width: 520, height: 760, focused: true });
}
chrome.action.onClicked.addListener(() => { openSettingsWindow().catch(err => console.error("[Code Genius GitHub Sync] 설정 창 열기 실패", err)); });
chrome.commands.onCommand.addListener((command) => { if (command === "open-settings") openSettingsWindow().catch(err => console.error(err)); });
const SCORE_WINDOW_MS = 15 * 60 * 1000;
const uploadLocks = new Map();
const processedSubmissions = new Set();

function withPathLock(key, task) {
  const previous = uploadLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  uploadLocks.set(key, current);
  return current.finally(() => {
    if (uploadLocks.get(key) === current) uploadLocks.delete(key);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CG_EVENT" || !message.payload) return;
  handleEvent(message.payload, sender).then(sendResponse).catch((err) => {
    console.error("[Code Genius GitHub Sync]", err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

async function handleEvent(event, sender) {
  if (event.kind === "debug") {
    const message = String(event.message || "");
    console.debug("[Code Genius GitHub Sync]", message);
    if (message.startsWith("페이지 요청 감지 훅 시작됨")) {
      const { pending = [] } = await chrome.storage.local.get("pending");
      const active = pending.some(p => p.status === "waiting_for_score" && Date.now() - p.startedAt < SCORE_WINDOW_MS);
      if (!active) await setStatus("제출 대기 중. 100점 제출 시 GitHub에 자동 업로드합니다.", "idle");
    } else if (message.startsWith("statistics 응답 감지:")) {
      // Existing problem statistics can load when merely opening a solved problem.
      // Do not change the status here; only a score event tied to an actual submission should advance it.
      console.debug("[Code Genius GitHub Sync] 기존 채점 통계 표시 (제출과 무관할 수 있음)");
    } else if (message.startsWith("statistics 요청 응답 포착")) {
      // This endpoint also runs when opening or refreshing an already-solved question.
      // Log it for diagnostics, but never show a waiting spinner unless submissionStart created an active attempt.
      console.debug("[Code Genius GitHub Sync] 채점 통계 응답 포착(상태 변경 없음)");
    } else if (message.startsWith("fetch 응답 분석 오류") || message.startsWith("XHR 응답 분석 오류")) {
      await setStatus(`채점 응답 분석 오류: ${message}`, "error");
    }
    return { ok: true, debug: true };
  }
  if (event.kind === "questionDetail") {
    if (!event.qitemId) return { ok: false, ignored: true };
    const { questionDetails = {} } = await chrome.storage.local.get("questionDetails");
    questionDetails[String(event.qitemId)] = {
      qitemId: String(event.qitemId),
      title: event.title || "",
      statement: event.statement || "",
      constraints: event.constraints || "",
      inputDescription: event.inputDescription || "",
      outputDescription: event.outputDescription || "",
      sampleInput1: event.sampleInput1 || "",
      sampleOutput1: event.sampleOutput1 || "",
      sampleInput2: event.sampleInput2 || "",
      sampleOutput2: event.sampleOutput2 || "",
      observedAt: event.observedAt || Date.now()
    };
    await chrome.storage.local.set({ questionDetails });
    return { ok: true, saved: true };
  }

  if (event.kind === "submissionStart") {
    if (!event.sourcecode || !event.qitemId || !event.attemptId) return { ok: false, ignored: true };
    const { attempts = [] } = await chrome.storage.local.get("attempts");
    const item = {
      ...event,
      tabId: sender.tab?.id ?? null,
      status: "submitting",
      // Use the timestamp from the page hook so it shares the same clock as score events.
      // Background receipt can happen a few milliseconds later than the statistics response.
      startedAt: event.observedAt || Date.now()
    };
    const next = attempts.filter(a => a.attemptId !== item.attemptId).concat(item).slice(-20);
    await chrome.storage.local.set({ attempts: next, lastStatus: {
      at: Date.now(), phase: "waiting",
      message: `제출 감지: ${item.language} 문제 ${item.qitemId}. 채점 결과를 확인하는 중입니다.`
    }});
    return { ok: true, started: true };
  }

  if (event.kind === "submission") {
    if (!event.sourcecode || !event.qitemId) return { ok: false, ignored: true };
    const { attempts = [], pending = [], recentScores = [] } = await chrome.storage.local.get(["attempts", "pending", "recentScores"]);
    const attemptId = event.attemptId;
    let attempt = attempts.find(a => a.attemptId === attemptId);
    if (!attempt) {
      // Fallback for cases where a browser/site implementation didn't expose the start event.
      attempt = {
        ...event,
        tabId: sender.tab?.id ?? null,
        startedAt: event.observedAt || Date.now(),
        status: "confirmed"
      };
    } else {
      attempt = { ...attempt, ...event, tabId: sender.tab?.id ?? attempt.tabId, status: "confirmed", confirmedAt: Date.now() };
    }
    const nextAttempts = attempts.filter(a => a.attemptId !== attemptId).concat(attempt).slice(-20);
    const nextPending = pending.filter(p => !(p.qitemId === attempt.qitemId && p.tabId === attempt.tabId));
    nextPending.push({ ...attempt, status: "waiting_for_score" });
    await chrome.storage.local.set({ attempts: nextAttempts, pending: nextPending.slice(-30), lastStatus: {
      at: Date.now(), phase: "waiting",
      message: `제출 완료: ${attempt.language} 문제 ${attempt.qitemId}. 100점 채점 결과를 확인하는 중입니다.`
    }});

    // Statistics can arrive before codingSubmit's success response. If we cached a fresh score
    // for this exact question after the request started, process it now.
    const matchedScore = recentScores
      .filter(s => String(s.qitemId) === String(attempt.qitemId) &&
        // A statistics response may be delivered just before the background receives submissionStart.
        // The page-hook timestamps are the same time base, so allow a small clock/order tolerance.
        s.observedAt >= ((attempt.startedAt || 0) - 3000) &&
        Date.now() - s.observedAt < 2 * 60 * 1000)
      .sort((a, b) => b.observedAt - a.observedAt)[0];
    if (matchedScore) {
      await setStatus(`채점 결과 연결 완료: 문제 ${attempt.qitemId}, ${matchedScore.score}/100. 업로드를 시작합니다.`, "uploading");
      return await processScoreForSubmission(matchedScore, attempt, sender);
    }
    return { ok: true, confirmed: true };
  }

  if (event.kind === "score") {
    if (!event.qitemId) return { ok: false, ignored: true };
    const { recentScores = [], attempts = [], pending = [] } = await chrome.storage.local.get(["recentScores", "attempts", "pending"]);

    // Polling after codingSubmit sends an explicit attemptId. Handle that correlation
    // before generic score deduplication, because the site's ordinary statistics
    // response may have the same qitem/score/submissionCount and otherwise suppress it.
    if (event.correlatedSubmission === true && event.attemptId) {
      const exactPending = pending.find(p =>
        p.attemptId === event.attemptId &&
        String(p.qitemId) === String(event.qitemId) &&
        p.status === "waiting_for_score"
      );
      if (!exactPending) {
        console.warn("[Code Genius GitHub Sync] 명시적 제출 점수를 받았지만 일치하는 대기 제출이 없습니다.", {
          qitemId: event.qitemId, attemptId: event.attemptId
        });
        return { ok: false, ignored: true, reason: "matching_attempt_not_found" };
      }
      const correlatedScore = { ...event, observedAt: event.observedAt || Date.now(),
        dedupeKey: `attempt:${event.attemptId}:${event.score}` };
      await chrome.storage.local.set({
        recentScores: recentScores.concat(correlatedScore).slice(-30)
      });
      await setStatus(`제출 건 연결 완료: 문제 ${event.qitemId}, ${event.score}/100. 업로드를 시작합니다.`, "uploading");
      return await processScoreForSubmission(correlatedScore, exactPending, sender);
    }

    const dedupeKey = `${event.qitemId}:${event.score}:${event.submissionCount ?? "na"}`;
    const seen = recentScores.some(s => s.dedupeKey === dedupeKey && Math.abs((s.observedAt || 0) - event.observedAt) < 5000);
    if (seen) return { ok: true, duplicate: true };

    const normalizedScore = { ...event, observedAt: event.observedAt || Date.now(), dedupeKey };
    await chrome.storage.local.set({ recentScores: recentScores.concat(normalizedScore).slice(-30) });

    // Match only a confirmed submission that started before this score response.
    const candidates = pending
      .filter(p => String(p.qitemId) === String(event.qitemId) &&
        p.status === "waiting_for_score" &&
        p.startedAt <= normalizedScore.observedAt &&
        normalizedScore.observedAt - p.startedAt < 2 * 60 * 1000)
      .sort((a, b) => b.startedAt - a.startedAt);

    if (!candidates.length) {
      // Statistics are also fetched when opening an already-solved problem.
      // Cache the response for possible correlation, but don't show a spinner or waiting status
      // unless an actual submission was observed.
      return { ok: true, cached: true, reason: "no_active_submission" };
    }
    return await processScoreForSubmission(normalizedScore, candidates[0], sender);
  }
  return { ok: false, ignored: true };
}


async function processScoreForSubmission(event, submission, sender) {
  if (event.score !== "100") {
    const { pending = [] } = await chrome.storage.local.get("pending");
    await chrome.storage.local.set({ pending: pending.filter(p => p.attemptId !== submission.attemptId) });
    await setStatus(`채점 완료: 문제 ${event.qitemId}, ${event.score}/100. 100점이 아니므로 업로드하지 않았습니다.`, "done");
    return { ok: true, uploaded: false, reason: "not_full_score" };
  }

  const normalizedLanguage = String(submission.language || "").trim().toUpperCase();
  if (!["JAVA", "PYTHON", "PYTHON3", "PYTHON 3"].includes(normalizedLanguage)) {
    await setStatus(`지원하지 않는 언어라 업로드하지 않았습니다: ${submission.language || "알 수 없음"}`, "done");
    return { ok: true, uploaded: false, reason: "unsupported_language" };
  }

  const submissionKey = `${submission.attemptId || submission.qitemId + ":" + submission.startedAt}:${normalizedLanguage}`;
  const { uploadedAttempts = [], githubOwner, githubRepo, githubBranch, githubToken, rootFolder, pending = [] } =
    await chrome.storage.local.get(["uploadedAttempts", "githubOwner", "githubRepo", "githubBranch", "githubToken", "rootFolder", "pending"]);
  if (uploadedAttempts.includes(submissionKey)) return { ok: true, uploaded: false, reason: "already_uploaded" };
  if (!githubOwner || !githubRepo || !githubToken) {
    await setStatus("100점 제출을 확인했지만 GitHub 설정이 없습니다. 설정 창(Alt+Shift+G)에서 GitHub를 연결해 주세요.", "error");
    return { ok: false, uploaded: false, error: "missing_github_settings" };
  }

  const settings = { githubOwner, githubRepo, githubBranch, githubToken, rootFolder };
  await setStatus(`100점 확인! ${normalizedLanguage} 코드를 GitHub에 업로드하는 중입니다. (문제 ${submission.qitemId})`, "uploading");
  const { questionDetails = {} } = await chrome.storage.local.get("questionDetails");
  const detail = questionDetails[String(submission.qitemId)] || null;
  const domTitle = await findQuestionTitle(submission.qitemId, submission.tabId);
  const title = detail?.title || domTitle || `문제 ${submission.qitemId}`;
  const folder = safeName(`${submission.qitemId}_${title}`);
  const root = (rootFolder || "CodeGenius").replace(/^\/+|\/+$/g, "");
  const languageFolder = languageDirectory(normalizedLanguage);
  const basePath = [root, languageFolder, folder].filter(Boolean).join("/");
  const codeName = sourceFilename(normalizedLanguage);
  const codePath = `${basePath}/${codeName}`;
  const readmePath = `${basePath}/README.md`;
  const readme = makeReadme(title, submission, event, detail);

  try {
    await withPathLock(`${githubOwner}/${githubRepo}/${basePath}`, async () => {
      await githubPutFile(settings, codePath, submission.sourcecode, `Save Code Genius solution: ${title || submission.qitemId} (${normalizedLanguage})`);
      await githubPutFile(settings, readmePath, readme, `Save Code Genius README: ${title || submission.qitemId} (${normalizedLanguage})`);
    });
  } catch (error) {
    await setStatus(`GitHub 업로드 실패: ${String(error?.message || error).slice(0, 180)}`, "error");
    throw error;
  }

  await chrome.storage.local.set({
    uploadedAttempts: uploadedAttempts.concat(submissionKey).slice(-200),
    pending: pending.filter(p => p.attemptId !== submission.attemptId)
  });
  await setStatus(`업로드 완료: ${basePath} (100점)`, "success");
  return { ok: true, uploaded: true, path: basePath };
}

function findPending(pending, qitemId, cutoff) {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (String(p.qitemId).trim() === String(qitemId).trim() &&
        p.observedAt >= cutoff && p.status === "waiting_for_score") return i;
  }
  return -1;
}

async function findQuestionTitle(qitemId, tabId) {
  // Best-effort title from page DOM. Never scrape arbitrary page content.
  if (tabId == null) return "";
  try {
    const results = await chrome.scripting?.executeScript?.({
      target: { tabId },
      func: () => {
        const selectors = ["h1", ".question-title", "[class*='qitemTtl']", "[class*='problem-title']"];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const value = el?.textContent?.trim();
          if (value && value.length < 160) return value;
        }
        return document.title || "";
      }
    });
    return String(results?.[0]?.result || "").trim();
  } catch (_) { return ""; }
}

function sourceFilename(language) {
  const lang = String(language || "").trim().toUpperCase();
  if (lang === "JAVA") return "Main.java";
  if (["PYTHON", "PYTHON3", "PYTHON 3"].includes(lang)) return "solution.py";
  return "solution.txt";
}

function safeName(value) {
  return String(value || "problem")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
}

function makeReadme(title, submission, scoreEvent, detail = null) {
  const clean = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
  const section = (heading, value) => clean(value) ? `\n\n## ${heading}\n\n${clean(value)}` : "";
  const sample = (heading, input, output) => {
    if (!clean(input) && !clean(output)) return "";
    return `\n\n### ${heading}\n\n**입력**\n\n\`\`\`text\n${clean(input)}\n\`\`\`\n\n**출력**\n\n\`\`\`text\n${clean(output)}\n\`\`\``;
  };

  return `# ${title}

- Code Genius 문제 ID: ${submission.qitemId}
- 실습 ID: ${submission.practiceId || "-"}
- 언어: ${submission.language || "-"}
- 점수: ${scoreEvent.score}/100
- 제출 시각: ${submission.solveEndTime || new Date(submission.observedAt || Date.now()).toLocaleString("ko-KR")}

${section("문제 설명", detail?.statement)}
${section("입력", detail?.inputDescription)}
${section("출력", detail?.outputDescription)}
${section("제한 사항", detail?.constraints)}
${sample("예제 1", detail?.sampleInput1, detail?.sampleOutput1)}
${sample("예제 2", detail?.sampleInput2, detail?.sampleOutput2)}
`.trim() + "\n";
}

async function githubPutFile(settings, path, content, message) {
  const owner = encodeURIComponent(settings.githubOwner.trim());
  const repo = encodeURIComponent(settings.githubRepo.trim());
  const branch = (settings.githubBranch || "main").trim();
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${settings.githubToken.trim()}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };

  const fetchWithRetry = async (url, options, operation) => {
    let lastError;
    for (let networkAttempt = 0; networkAttempt < 3; networkAttempt++) {
      try {
        return await fetch(url, options);
      } catch (error) {
        lastError = error;
        // TypeError: Failed to fetch is commonly a transient network/service-worker
        // failure. Retry briefly before surfacing a useful diagnostic.
        if (networkAttempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (networkAttempt + 1)));
        }
      }
    }
    throw new Error(`${operation}: GitHub API에 연결하지 못했습니다. 네트워크, VPN/프록시 또는 api.github.com 접근을 확인해 주세요. (${String(lastError?.message || lastError)})`);
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let sha;
    const existing = await fetchWithRetry(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers }, "GitHub 파일 조회 실패");
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    } else if (existing.status !== 404) {
      const detail = await existing.text();
      throw new Error(`GitHub 파일 조회 실패 (${existing.status}): ${detail.slice(0, 220)}`);
    }

    const body = { message, content: toBase64Utf8(content), branch };
    if (sha) body.sha = sha;

    const response = await fetchWithRetry(apiUrl, { method: "PUT", headers, body: JSON.stringify(body) }, "GitHub 업로드 실패");
    if (response.ok) return;

    const detail = await response.text();
    if (response.status === 409 && attempt < 2) {
      // Another extension event or external Git operation changed the file after SHA lookup.
      continue;
    }
    throw new Error(`GitHub 업로드 실패 (${response.status}): ${detail.slice(0, 260)}`);
  }
  throw new Error("GitHub 업로드 실패: 최신 파일 SHA를 확인한 뒤에도 충돌이 반복됩니다.");
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function setStatus(message, phase = "done") {
  await chrome.storage.local.set({ lastStatus: { at: Date.now(), message, phase } });
}

function languageDirectory(language) {
  const lang = String(language || "").trim().toUpperCase();
  if (lang === "JAVA") return "Java";
  if (["PYTHON", "PYTHON3", "PYTHON 3"].includes(lang)) return "Python";
  return "Other";
}