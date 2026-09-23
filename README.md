# gemini-relay

Cloudflare Workers에서 Google Gemini API를 직접 호출하면 **간헐적으로 거부당한다.**
Cloudflare Workers는 사용자와 가장 가까운 전 세계 엣지 위치에서 요청마다 다르게 실행되는데,
Gemini API는 일부 지역의 접근을 차단하기 때문이다(`User location is not supported for the API use`,
`FAILED_PRECONDITION`). 같은 질문인데도 어느 엣지가 처리하느냐에 따라 성공/실패가 갈린다.

이 문제를 해결하기 위해, **항상 같은 리전에서 도는 작은 중계 서버**를 하나 두고
Cloudflare Worker가 Gemini를 직접 호출하는 대신 이 릴레이를 거치게 한다.
Google 인프라(Cloud Run) → Google API 호출이라 지역 차단이 발생하지 않는다.

```
Cloudflare Worker → (이 릴레이, Cloud Run 고정 리전) → generativelanguage.googleapis.com
```

순수 패스스루 프록시다. 요청을 그대로 전달하고 응답을 그대로 돌려줄 뿐, API 키를 저장하지 않는다.

---

## 고객(신규) 계정에 새로 구성하는 절차

아래 절차는 **고객의 Google Cloud 계정**에서 처음부터 이 릴레이를 새로 만들 때 그대로 따라 하면 된다.
(강서나눔돌봄센터 건은 `jaewoolee.ai@gmail.com` 계정에 이미 구성되어 있고, 이 문서는 **다른 고객**에게
같은 구조를 복제할 때 쓰는 매뉴얼이다.)

### 0. 준비물

- 고객 명의(또는 앞으로 고객에게 넘길) Google 계정
- 해당 계정에 연결된 결제 수단(신용카드) — Cloud Run 자체는 무료 티어로 충분하지만,
  프로젝트에 결제 계정을 "연결"하는 것 자체는 필수다(청구가 실제로 발생하지 않아도 연결은 필요)

### 1. Google Cloud CLI 설치 (최초 1회, PC마다)

macOS 기준:

```bash
brew install --cask google-cloud-sdk
```

설치 후 PATH에 추가되지 않았다면 매 명령 앞에 아래를 붙이거나, 쉘 프로필(`.zshrc` 등)에 추가한다.

```bash
export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
```

### 2. 로그인

```bash
gcloud auth login
```

브라우저가 열리면 **고객 계정**(또는 고객에게 넘길 계정)으로 로그인한다.

### 3. 프로젝트 생성

```bash
gcloud projects create gangseo-gemini-relay --name="Gangseo Gemini Relay"
gcloud config set project gangseo-gemini-relay
```

> 프로젝트 ID(`gangseo-gemini-relay` 부분)는 전역적으로 유일해야 한다. 다른 고객에게 복제할 때는
> `고객명-gemini-relay` 처럼 이름을 바꿔서 사용한다.

### 4. 결제 계정 연결

```bash
gcloud billing accounts list
```

결과로 나온 `ACCOUNT_ID`를 아래에 넣는다.

```bash
gcloud billing projects link gangseo-gemini-relay --billing-account="여기에_ACCOUNT_ID"
```

> 결제 계정이 아예 없다면, [Google Cloud Console](https://console.cloud.google.com/billing) →
> "결제 계정 만들기"로 먼저 만들어야 한다(콘솔 UI 작업, CLI로는 생성 불가).

### 5. 필요한 API 활성화

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### 6. 이 저장소를 배포

이 저장소(`gemini-relay`)를 clone한 뒤, 그 디렉터리 안에서:

```bash
gcloud run deploy gemini-relay \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --project gangseo-gemini-relay \
  --quiet
```

- `--region`은 서비스 지역과 무관하게 **Gemini API가 차단하지 않는 리전이면 어디든 상관없다**
  (`asia-northeast3` = 서울). 굳이 바꿀 필요는 없다.
- `--allow-unauthenticated`는 필수다 — 이 서비스는 자체적으로 API 키를 검사하지 않고
  호출자가 넘긴 키를 그대로 전달하는 구조이기 때문에, Cloud Run 자체 인증을 켜면 호출이 막힌다.

배포가 끝나면 마지막 줄에 `Service URL: https://gemini-relay-XXXXXXXX.asia-northeast3.run.app`이
출력된다. **이 URL을 기억해둔다.**

### 7. 챗봇 쪽에 연결

`gangseo_chatbot_web` 저장소(포크한 고객용 저장소)의 **Cloudflare 배포 환경변수**에 추가한다.

| 변수명 | 값 |
| --- | --- |
| `GEMINI_RELAY_URL` | 6번 단계에서 나온 Service URL (예: `https://gemini-relay-xxxx.asia-northeast3.run.app`) |

`lib/rag.ts`의 `GEMINI_UPSTREAM_BASE`는 이 환경변수가 있으면 그 값을, 없으면 강서나눔돌봄센터용
기본값을 쓰도록 되어 있다. **고객마다 반드시 이 환경변수를 새로 설정해야, 각자 자기 자신의
Cloud Run 릴레이를 쓰게 된다.** (환경변수를 빠뜨리면 강서나눔돌봄센터 릴레이로 잘못 연결된다.)

Cloudflare 재배포 후, 실제로 정상 작동하는지 확인한다(아래 "동작 확인" 참고).

---

## 배포 시 겪을 수 있는 문제 (실제로 겪은 것들)

### "Failed to resolve version 20 for Node.js"

`package.json`의 `engines.node`를 `"20"`으로 두면 빌드가 실패한다. Cloud Run의 Node.js
빌드팩이 더 이상 Node 20을 지원하지 않는다(2026년 9월 기준 22 이상만 지원). 이 저장소는 이미
`"22"`로 고쳐져 있으니, 혹시 나중에 빌드가 이 에러로 실패하면 `package.json`의 버전 번호를
그 시점에 지원되는 버전으로 올린다.

### API 키를 넣었는데 "Missing x-relay-api-key" 에러가 남

Cloud Run의 프론트엔드 프록시가 **`x-goog-*`로 시작하는 헤더를 자동으로 제거한다**
(Google 내부 인프라용으로 예약된 이름이기 때문). 그래서 원래 Gemini API가 쓰는
`x-goog-api-key` 헤더를 그대로 전달받으면 값이 비어버린다. 이 저장소의 코드는 이미
`x-relay-api-key`라는 다른 이름으로 받아서 내부적으로 `x-goog-api-key`로 바꿔 보내도록
되어 있다 — **호출하는 쪽(Cloudflare Worker)도 반드시 `x-relay-api-key` 헤더로 보내야 한다.**
(`gangseo_chatbot_web`의 `lib/rag.ts`는 이미 이렇게 되어 있다.)

---

## 동작 확인

배포 후 아래처럼 직접 호출해서 200이 오는지 확인한다. `GEMINI_API_KEY`는 관리자
통제반(Streamlit)의 LLM API 관리 화면에서 등록한 Gemini 키를 그대로 쓴다.

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "https://여기에_배포된_URL/v1beta/models/gemini-embedding-001:embedContent" \
  -H "x-relay-api-key: 여기에_GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":{"parts":[{"text":"테스트"}]},"output_dimensionality":1536}'
```

`200`이 나오면 정상이다.

---

## 비용

- Cloud Run 무료 티어: 월 200만 요청 (하루 150명 규모 챗봇이면 절대 초과하지 않음)
- 실질 비용: **$0** (결제 계정 연결은 필수이지만 실제 청구는 발생하지 않음)
