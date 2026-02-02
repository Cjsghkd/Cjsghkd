/**
 *
 * @source https://github.com/dbwls99706/oss-contribution-card
 */

import https from 'https';

const REQUEST_TIMEOUT = 30000; // 30초

// ===============================
// Repo 정보 캐시 (API 중복 호출 방지)
// ===============================
const repoInfoCache = new Map();

function httpsGet(url, headers, retries = 3) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        ...headers,
        'User-Agent': 'github-contribution-widget'
      },
      timeout: REQUEST_TIMEOUT
    };

    const makeRequest = (attempt) => {
      const req = https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse JSON response'));
            }
            return;
          }

          // Rate limit 처리
          if (res.statusCode === 403) {
            const rateLimitRemaining = res.headers['x-ratelimit-remaining'];
            const rateLimitReset = res.headers['x-ratelimit-reset'];
            if (rateLimitRemaining === '0') {
              const resetDate = rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000) : null;
              reject(new Error(`GitHub API rate limit exceeded. Resets at: ${resetDate ? resetDate.toISOString() : 'unknown'}`));
              return;
            }
          }

          // 인증 오류
          if (res.statusCode === 401) {
            reject(new Error('GitHub API authentication failed. Please check your token.'));
            return;
          }

          // 서버 오류 재시도
          if (res.statusCode >= 500 && attempt < retries) {
            const delay = Math.pow(2, attempt) * 1000;
            setTimeout(() => makeRequest(attempt + 1), delay);
            return;
          }

          reject(new Error(`GitHub API error: ${res.statusCode}`));
        });
      });

      req.on('error', (err) => {
        if (attempt < retries && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN')) {
          const delay = Math.pow(2, attempt) * 1000;
          setTimeout(() => makeRequest(attempt + 1), delay);
          return;
        }
        reject(new Error(`Network error: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          setTimeout(() => makeRequest(attempt + 1), delay);
          return;
        }
        reject(new Error('Request timed out'));
      });
    };

    makeRequest(0);
  });
}

// ===============================
// repo 정보 조회 (owner.type 확인용)
// ===============================
async function fetchRepoInfo(repoFullName, headers) {
  if (repoInfoCache.has(repoFullName)) {
    return repoInfoCache.get(repoFullName);
  }

  const url = `https://api.github.com/repos/${repoFullName}`;
  const repoData = await httpsGet(url, headers);

  repoInfoCache.set(repoFullName, repoData);
  return repoData;
}

export async function fetchContributions(username, token = null) {
  if (!username || typeof username !== 'string') {
    throw new Error('Username is required and must be a string');
  }

  const sanitizedUsername = username.trim();
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(sanitizedUsername)) {
    throw new Error('Invalid GitHub username format');
  }

  const headers = {
    'Accept': 'application/vnd.github.v3+json'
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // 자신의 레포를 제외한 merged PR 검색
  const query = encodeURIComponent(`author:${sanitizedUsername} type:pr is:merged -user:${sanitizedUsername}`);
  const url = `https://api.github.com/search/issues?q=${query}&per_page=100&sort=updated`;

  let data;
  try {
    data = await httpsGet(url, headers);
  } catch (err) {
    throw new Error(`Failed to fetch contributions: ${err.message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid response from GitHub API');
  }

  const repoMap = new Map();
  const items = Array.isArray(data.items) ? data.items : [];

  for (const item of items) {
    if (!item || !item.repository_url) continue;

    const repoFullName = item.repository_url.replace('https://api.github.com/repos/', '');
    if (!repoFullName || repoFullName === item.repository_url) continue;

    // =========================================
    // 🔥 A안 적용: Organization repo 제외
    // =========================================
    let repoInfo;
    try {
      repoInfo = await fetchRepoInfo(repoFullName, headers);
    } catch (e) {
      continue; // repo 정보 못 가져오면 스킵
    }

    if (repoInfo?.owner?.type === 'Organization') {
      continue; // 조직 repo 제거
    }
    // =========================================

    if (!repoMap.has(repoFullName)) {
      repoMap.set(repoFullName, {
        name: repoFullName,
        prs: [],
        latestMerge: null
      });
    }

    const repo = repoMap.get(repoFullName);
    const mergedAt = item.pull_request?.merged_at || null;

    repo.prs.push({
      number: item.number || 0,
      title: item.title || 'Untitled PR',
      url: item.html_url || '',
      mergedAt: mergedAt
    });

    if (mergedAt && (!repo.latestMerge || new Date(mergedAt) > new Date(repo.latestMerge))) {
      repo.latestMerge = mergedAt;
    }
  }

  const contributions = Array.from(repoMap.values())
    .sort((a, b) => b.prs.length - a.prs.length);

  return {
    username: sanitizedUsername,
    totalPRs: data.total_count || 0,
    totalRepos: contributions.length,
    contributions
  };
}
