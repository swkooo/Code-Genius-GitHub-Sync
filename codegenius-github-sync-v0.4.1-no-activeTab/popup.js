const $ = id => document.getElementById(id);
const WORKER_BASE = 'https://code-genius-github-sync.seowon710.workers.dev';
let oauthPollTimer = null;
let oauthSession = null;
let oauthDeadline = 0;
function renderStatus(status){const message=status?.message||"아직 감지된 제출이 없습니다.";const phase=status?.phase||"idle";$('status').textContent=message;const busy=phase==='waiting'||phase==='uploading';$('spinner').classList.toggle('hidden',!busy);$('progressTrack').classList.toggle('hidden',!busy);}
async function load(){const d=await chrome.storage.local.get(['githubUser','githubOwner','githubRepo','githubBranch','githubToken','rootFolder','lastStatus']);$('branch').value=d.githubBranch||'main';$('root').value=d.rootFolder||'CodeGenius';renderStatus(d.lastStatus);if(d.githubToken&&d.githubUser){$('authStatus').textContent=`인증 성공: ${d.githubUser.login}`;$('connect').textContent='GitHub로 인증 완료';$('connect').disabled=true;$('refreshRepos').disabled=false;$('createRepo').disabled=false;await loadRepos(d.githubToken,d.githubOwner,d.githubRepo);if(d.githubOwner&&d.githubRepo){$('saveRepo').textContent='저장소 연결 완료';$('saveRepo').disabled=true;}}else{$('authStatus').textContent='아직 GitHub에 연결되지 않았습니다.';$('connect').textContent='GitHub로 인증하기';$('connect').disabled=false;$('refreshRepos').disabled=true;$('createRepo').disabled=true;}}
async function api(path,token,options={}){const r=await fetch('https://api.github.com'+path,{...options,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28',...(options.headers||{})}});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={message:t}}if(!r.ok)throw new Error(`GitHub API 오류 (${r.status}): ${j.message||t}`);return j;}
async function loadRepos(token,owner='',repo=''){
  const sel=$('repoSelect'); $('repoStatus').textContent='저장소 목록을 불러오는 중…';
  try {
    let repos=[];
    for(let page=1; page<=10; page++){
      const batch=await api(`/user/repos?per_page=100&page=${page}&sort=updated&visibility=all&affiliation=owner,collaborator,organization_member`,token);
      repos.push(...batch); if(batch.length<100) break;
    }
    sel.replaceChildren();
    for(const r of repos){const o=document.createElement('option');o.value=JSON.stringify({owner:r.owner.login,repo:r.name,full_name:r.full_name,default_branch:r.default_branch});o.textContent=r.full_name;sel.append(o);}
    if(!repos.length) sel.add(new Option('접근 가능한 저장소가 없습니다.',''));
    else {const chosen=repos.find(r=>r.owner.login===owner&&r.name===repo)||repos[0];sel.value=JSON.stringify({owner:chosen.owner.login,repo:chosen.name,full_name:chosen.full_name,default_branch:chosen.default_branch});$('branch').value=chosen.default_branch||'main';}
    sel.disabled=!repos.length; const connected=!!(owner&&repo&&repos.some(r=>r.owner.login===owner&&r.name===repo)); $('saveRepo').disabled=!repos.length||connected; $('saveRepo').textContent=connected?'저장소 연결 완료':'저장소 연결 저장'; $('refreshRepos').disabled=false; $('createRepo').disabled=false; 
    $('repoStatus').textContent=`저장소 ${repos.length}개를 불러왔습니다.`;
  } catch(e) {
    $('repoStatus').textContent=`저장소 목록 조회 실패: ${e.message}`;
    if(/403|Resource not accessible|Not Found/i.test(e.message)) $('repoStatus').textContent+=' — OAuth 승인 시 repo 권한이 부여되었는지 확인하세요. 비공개 저장소 접근에는 repo 범위가 필요합니다.';
  }
}
$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  $('authStatus').textContent = 'GitHub 인증을 진행하고 있습니다…';
  $('connect').textContent = '인증 진행 중…';
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    oauthSession = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    oauthDeadline = Date.now() + 5 * 60 * 1000;
    // Open the authorization tab immediately from the user's click handler.
    const authUrl = `${WORKER_BASE}/oauth/start?session=${encodeURIComponent(oauthSession)}`;
    await chrome.tabs.create({ url: authUrl, active: true });
    await chrome.storage.local.set({ oauthSession, oauthStartedAt: Date.now() });
    pollWorkerResult();
  } catch (e) {
    $('authStatus').textContent = `인증 시작 실패: ${e.message}`;
    $('connect').disabled = false;
  }
});

async function pollWorkerResult() {
  if (oauthPollTimer) clearTimeout(oauthPollTimer);
  if (!oauthSession) return;
  if (Date.now() > oauthDeadline) {
    $('authStatus').textContent = '인증 대기 시간이 만료되었습니다. 다시 시도하세요.';
    $('connect').textContent = 'GitHub로 인증하기';
    $('connect').disabled = false;
    oauthSession = null;
    return;
  }
  oauthPollTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${WORKER_BASE}/oauth/poll?session=${encodeURIComponent(oauthSession)}`, { cache: 'no-store' });
      const data = await r.json();
      if (r.status === 202 || data.status === 'pending') {
        $('authStatus').textContent = 'GitHub 로그인 및 권한 승인을 기다리는 중…';
        return pollWorkerResult();
      }
      if (!r.ok || data.status !== 'authorized' || !data.credentials?.access_token) {
        throw new Error(data.error || `Worker 응답 오류 (${r.status})`);
      }
      const token = data.credentials.access_token;
      const user = await api('/user', token);
      await chrome.storage.local.set({
        githubToken: token,
        githubUser: { login: user.login, id: user.id },
        githubTokenExpiresAt: data.credentials.expires_in ? Date.now() + data.credentials.expires_in * 1000 : null,
        githubRefreshToken: data.credentials.refresh_token || null,
        githubRefreshTokenExpiresIn: data.credentials.refresh_token_expires_in || null,
        oauthSession: null,
        oauthStartedAt: null
      });
      $('authStatus').textContent = `인증 성공: ${user.login}`;
      $('connect').textContent = 'GitHub로 인증 완료';
      $('connect').disabled = true;
      oauthSession = null;
      await loadRepos(token);
    } catch (e) {
      $('authStatus').textContent = `인증 결과 확인 실패: ${e.message}`;
      $('connect').textContent = 'GitHub로 인증하기';
      $('connect').disabled = false;
      oauthSession = null;
    }
  }, 2000);
}

$('refreshRepos').addEventListener('click',async()=>{const d=await chrome.storage.local.get(['githubToken','githubOwner','githubRepo']);if(!d.githubToken){$('repoStatus').textContent='먼저 GitHub 인증을 진행하세요.';return;}await loadRepos(d.githubToken,d.githubOwner,d.githubRepo);});

$('createRepo').addEventListener('click',async()=>{
  const name=$('newRepoName').value.trim(), description=$('newRepoDescription').value.trim();
  const autoInit=$('newRepoInitialize').checked;
  if(!name){$('repoStatus').textContent='저장소 이름을 입력하세요.';return;}
  if(!/^[A-Za-z0-9._-]+$/.test(name)||name==='.'||name==='..'){$('repoStatus').textContent='저장소 이름에는 영문자, 숫자, 점(.), 하이픈(-), 밑줄(_)만 사용할 수 있어요.';return;}
  const {githubToken}=await chrome.storage.local.get(['githubToken']);
  if(!githubToken){$('repoStatus').textContent='먼저 GitHub 인증을 진행하세요.';return;}
  $('createRepo').disabled=true;$('repoStatus').textContent='공개 GitHub 저장소를 생성하는 중…';
  try{
    const created=await api('/user/repos',githubToken,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description,private:false,auto_init:autoInit})});
    await loadRepos(githubToken,created.owner.login,created.name);
    const selected={owner:created.owner.login,repo:created.name,full_name:created.full_name,default_branch:created.default_branch||'main'};
    $('repoSelect').value=JSON.stringify(selected);$('branch').value=selected.default_branch;
    await chrome.storage.local.set({githubOwner:selected.owner,githubRepo:selected.repo,githubBranch:selected.default_branch,rootFolder:$('root').value.trim()||'CodeGenius'});
    $('repoStatus').textContent=`공개 저장소 생성 및 연결 완료: ${created.full_name}`;
    $('newRepoName').value='CodingTest';
  }catch(e){
    let message=e.message;
    if(/403|Resource not accessible|not have permission|Insufficient permission/i.test(message)) message+=' — OAuth App 인증 시 repo 권한을 승인했는지 확인하세요. GitHub 계정에 저장소 생성 제한이 있는 경우 생성이 거부될 수 있습니다.';
    else if(/422/.test(message)) message+=' — 저장소 이름이 이미 사용 중이거나 GitHub 저장소 이름 규칙에 맞지 않을 수 있습니다.';
    $('repoStatus').textContent=`저장소 생성 실패: ${message}`;
  }finally{$('createRepo').disabled=false;}
});

$('saveRepo').addEventListener('click',async()=>{try{const d=JSON.parse($('repoSelect').value);const token=(await chrome.storage.local.get('githubToken')).githubToken;if(!token)throw new Error('먼저 GitHub 인증을 진행하세요.');await api(`/repos/${encodeURIComponent(d.owner)}/${encodeURIComponent(d.repo)}`,token);await chrome.storage.local.set({githubOwner:d.owner,githubRepo:d.repo,githubBranch:$('branch').value.trim()||d.default_branch||'main',rootFolder:$('root').value.trim()||'CodeGenius'});$('repoStatus').textContent=`연결 저장 완료: ${d.full_name}`;$('saveRepo').textContent='저장소 연결 완료';$('saveRepo').disabled=true;}catch(e){$('repoStatus').textContent=`저장 실패: ${e.message}`;}});
function enableRepoSave(){if($('repoSelect').value){$('saveRepo').textContent='저장소 연결 저장';$('saveRepo').disabled=false;}}
$('repoSelect').addEventListener('change',enableRepoSave);$('branch').addEventListener('input',enableRepoSave);$('root').addEventListener('input',enableRepoSave);
$('refresh').addEventListener('click',load);chrome.storage.onChanged.addListener((c,a)=>{if(a==='local'&&c.lastStatus)renderStatus(c.lastStatus.newValue);});load().catch(e=>$('status').textContent=e.message);
