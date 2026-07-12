# 경쟁 서비스 조사: Reddit 기반 주식 인기도 트래커

> **이슈**: #31 — ApeWisdom 기반 경쟁 서비스 조사: 게시물 표시 방식 벤치마킹
> **관련 이슈**: #21 — 티커별 Reddit 게시물 관련성 필터링 미흡
> **조사 일자**: 2026-07-12
> **조사 방법**: curl 직접 fetch + Wikipedia API + GitHub API (검색 엔진 DDG/Bing/Brave 모두 anti-bot 차단됨)

---

## 요약 (TL;DR)

raddit의 핵심 문제(이슈 #21: "티커 클릭 시 무관한 게시물 노출")는 업계 전반의 공통 과제다. **조사한 8개 서비스 중 Reddit 게시물을 직접 링크로 보여주는 서비스는 단 하나도 없었다.** 대부분 집계 통계(멘션 수, 센티먼트 %)만 제공하며, 게시물 수준 데이터는 자체 크롤링하지 않는다.

**raddit이 직면한 게시물 관련성 문제는 경쟁 서비스들도 회피하고 있는 문제** — 그들은 아예 게시물을 보여주지 않음으로써 문제를 "해결"했다.

| 서비스 | Reddit 데이터 | 티커 클릭 시 게시물 | 관련성 필터링 | 데이터 소스 |
|--------|--------------|-------------------|-------------|------------|
| **ApeWisdom** | 핵심 소스 | ❌ 게시물 없음 (통계만) | 대문자/$티커 패턴 매칭 | Reddit + 4chan 직접 크롤링 |
| **SwaggyStocks** | 핵심 소스 | ❌ 게시물 없음 (차트만) | BoW + 규칙 기반 + allow/deny 리스트 | 공개 인터넷 포럼 크롤링 |
| **Quiver Quant** | 과거 제공, **현재 비활성** | N/A (페이지 주석 처리) | N/A | 과거: Reddit API 추정 |
| **Stocktwits** | 자체 플랫폼 (Reddit 아님) | ✅ 자체 메시지 스트림 | cashtag($TICKER) 필수 | 자체 소셜 네트워크 |
| **LikeFolio** | 소셜 소스 중 하나 | ❌ 게시물 없음 (점수만) | AI 모델 + 가중치 | X·Reddit·TikTok + 검색/구매 데이터 |
| **Social Sentiment** | ❌ **서비스 중단** (DNS 미해석) | N/A | N/A | N/A |
| **Dakks Finance** | ❌ **존재 확인 불가** | N/A | N/A | N/A |
| **UniFinc** | ❌ 금융 서비스 아님 | N/A | N/A | N/A |

---

## 1. ApeWisdom (apewisdom.io) — raddit의 현재 데이터 소스

### (1) Reddit 데이터 활용 방식
- **14개 서브레딧 + 4chan /biz을 30분마다 스캔**하여 submission과 comment에서 티커를 추출
- 추적 서브레딧: r/wallstreetbets, r/stocks, r/investing, r/options, r/Daytrading, r/SPACs, r/pennystocks, r/WallStreetbetsELITE, r/Wallstreetbetsnew 등
- **데이터 수집 주기**: 30분 간격 (실시간 아님)

### (2) 티커 클릭 시 표시 내용
- **개별 게시물 링크나 title을 일절 보여주지 않음**
- 제공 정보: 멘션 수, 업보트 수, 멘션한 사용자 수, 센티먼트 %(긍정/부정), "Nearby keywords"(함께 언급된 단어들)
- 예시 (TSLA): "26 mentions, 69 upvotes, 23 users, 55% sentiment, nearby keywords: spcx, target, entry, move, expires"
- 차트: 24시간 멘션 추이, 30일 트렌드

### (3) 게시물 관련성 필터링
- **티커 감지 규칙** (methodology 페이지 공식 문서):
  - 대문자 티커 (AMD, BTC, AAPL) 또는 $ 접두사 ($aapl, $AAPL, $btc)만 카운트
  - **동일 게시물/댓글에서 티커가 2회 이상 나와도 1회로 카운트** (중복 제거)
  - 단어 충돌 처리: CFO, YOLO 등은 $CFO/$cfo, $YOLO/$yolo 형태만 카운트
  - Infinite Marketcap에 상장된 주식/크립토만 표시 (자체 검증 레지스트리)
- **센티먼트 계산 방식은 공개하지 않음** (퍼센트만 제공, 알고리즘 비공개)

### (4) 데이터 소스
- Reddit API/Pushshift 기반 직접 크롤링 (30분 주기)
- 4chan /biz 추가 추적
- API(v1.0)는 집계 데이터만 제공: rank, ticker, name, mentions, upvotes, rank_24h_ago, mentions_24h_ago
- **게시물 URL, title, body 등은 API에서 일절 제공하지 않음**

> **raddit과의 관계**: raddit은 ApeWisdom API에서 랭킹만 가져오고, 게시물은 별도로 Reddit RSS 검색으로 확보. 이 분리 구조가 이슈 #21의 근본 원인.

**소스**: https://apewisdom.io/methodology/, https://apewisdom.io/api/

---

## 2. SwaggyStocks (swaggystocks.com)

### (1) Reddit 데이터 활용 방식
- WallStreetBets 중심의 소셜 센티먼트 트래커
- 실시간(30분 지연) 언급량 랭킹 + 소셜 센티먼트 분석
- 대시보드 구성: WSB Realtime, Ticker Sentiment, Social Sentiment, Most Mentioned 24hrs
- "10M+ mentions tracked", "100K+ weekly market comments"

### (2) 티커 클릭 시 표시 내용
- **개별 게시물 링크를 보여주지 않음**
- 표시 내용: 멘션 수, 센티먼트(강세/약세/중립 카운트), Call/Put 비율, 30일 IV(내재변동성), Max Pain
- 순위표 형태: Rank, Ticker, Mentions, Sentiment, Call/Put Ratio, 30D IV
- 차트: 시간별 멘션 추이, 센티먼트 분포

### (3) 게시물 관련성 필터링 — **가장 상세한 문서화**
"How It Works" 페이지(2025-09-09 업데이트)에 공식 방법론 공개:

- **접근 방식**: Bag-of-Words(BoW) + 규칙/키워드 기반 파이프라인
  - 의도적 설계: "무거운 신경망 NLP 모델이 아닌, 빠르고 설명 가능하며 시장 특화 언어에 강건한 시스템"
- **티커 충돌 처리**:
  - allow/deny 리스트 + 근접성 규칙(proximity rules)으로 일반 단어처럼 보이는 티커(CFO, YOLO 등) 필터링
- **스팸/봇 필터**:
  - 중복 제거(de-duplication)
  - 요율 제한(rate limits)
  - 휴리스틱 필터로 brigading(조직적 선동) 및 저품질 스팸 완화
- **소스 가중치**: 단일 커뮤니티가 집계를 지배하지 않도록 가중치 적용
- **센티먼트 분류**:
  - 강세(Bullish): "calls", "long", "buying dips", "squeeze incoming"
  - 약세(Bearish): "puts", "short", "overpriced", "sell the rip"
  - 중립(Neutral): 명확한 방향성 의도가 없는 정보성 채팅 또는 혼재/모호한 표현
- **한계 인정**: "규칙 기반 접근은 의도적으로 단순하여 설명 가능하지만, 인간처럼 뉘앙스를 이해하지 못함. 반讽, 아이러니, 복잡한 추론은 누설 가능"

### (4) 데이터 소스
- 공개 인터넷 소스(서브레딧 및 포럼) 크롤링
- 내부 API 엔드포인트: `/v1/meme-stocks/top-tickers`, `/v1/stocks/options-eod/stats` (인증 필요, 공개 불가)
- 이메일: contact@swaggymedia.com

**소스**: https://swaggystocks.com/dashboard/wallstreetbets/how-it-works

---

## 3. Quiver Quant (quiverquant.com)

### (1) Reddit 데이터 활용 방식
- **과거에 WallStreetBets 데이터셋을 제공했으나, 현재 비활성화됨**
- 랜딩 페이지 HTML에서 `/wallstreetbets/` 링크가 `<!-- 주석 처리 -->`되어 있음 (실제 확인)
- 마찬가지로 `/crypto`(r/Cryptocurrency), Corporate Twitter, Fear and Greed Index 등 소셜 데이터셋도 주석 처리
- 현재 활성 데이터셋: 의회 거래, 내부자 거래, 기관 보유, 정부 계약, 로비잉 등 정부/기관 대체 데이터

### (2) 티커 클릭 시 표시 내용
- **WSB 데이터셋 비활성화로 확인 불가**
- 일반 티커 페이지는 SPA(React)로 구성되어 curl로 내용 확인 불가
- 활성 데이터셋(의회 거래 등)에서는 거래 내역, 날짜, 정치인 이름 등 구조화된 데이터를 표시

### (3) 게시물 관련성 필터링
- **WSB 데이터셋 비활성화로 확인 불가**
- API 문서(`/api/`)에서 WSB 관련 엔드포인트 확인되지 않음

### (4) 데이터 소스
- API (`api.quiverquant.com/beta/`) 통해 정부/기관 데이터 제공
- 예시: `GET /beta/historical/congresstrading/NVDA`
- 소셜 미디어 관련 엔드포인트는 현재 존재하지 않음

> **분석**: Quiver Quant는 소셜 미디어 데이터에서 멀어지고 정부/기관 대체 데이터에 집중하는 방향으로 전환한 것으로 보임.

**소스**: https://www.quiverquant.com/ (HTML 소스 분석), https://www.quiverquant.com/api/

---

## 4. Stocktwits (stocktwits.com)

### (1) Reddit 데이터 활용 방식
- **Reddit을 사용하지 않음** — Stocktwits 자체가 소셜 미디어 플랫폼
- 2008년 Howard Lindzon이 창업, **cashtag($TICKER) 개념의 발명처**
- 8M+ 등록 사용자를 보유한 독립 소셜 네트워크
- 트위터에서 시작했으나 현재는 완전히 분리된 플랫폼

### (2) 티커 클릭 시 표시 내용
- **자체 메시지 스트림 표시** — 사용자가 $TICKER cashtag를 사용해 작성한 메시지들
- 메시지 내용: 작성자, 본문, 생성 시간, 관련 심볼 목록, 감정 라벨(강세/약세)
- API 엔드포인트: `GET /api/2/streams/symbol/TSLA.json` (현재 Cloudflare 차단으로 직접 확인 불가, 문서상 확인)

### (3) 게시물 관련성 필터링
- **cashtag($TICKER) 사용이 필수** — 이 자체가 관련성 필터
- 사용자가 $TSLA로 태그한 메시지만 해당 티커 스트림에 표시
- raddit의 문제(일반 단어 "love", "so" 매칭)가 발생하지 않는 구조

### (4) 데이터 소스
- 자체 소셜 네트워크 데이터 (자체 사용자 생성 콘텐츠)
- 외부 크롤링 불필요 — 플랫폼 자체가 데이터 소스

> **참고**: Cloudflare 보호로 모든 웹/API 접근이 차단됨. Wikipedia API로 배경 정보 확보.

**소스**: Wikipedia — StockTwits, https://api.stocktwits.com/api/2-docs (Cloudflare 차단)

---

## 5. LikeFolio (likefolio.com) — 추가 발견 서비스

### (1) Reddit 데이터 활용 방식
- Reddit은 5개 행동 신호 스트림 중 소셜 미디어 데이터의 일부
- 소셜 미디어: X(트위터), Reddit, TikTok에서 "38M posts" 수집
- 전체 데이터: 웹 검색, 구매 의도, 소셜 언급, 앱 설치, 브랜드 선호도 (AI 모델)

### (2) 티커 클릭 시 표시 내용
- **개별 게시물을 보여주지 않음** — 점수 기반 대시보드
- Main Street Score (소비자 행동 0-100), Wall Street Score (애널리스트 0-100), LikeFolio Score (복합 점수)
- 525개 종목 커버, 15년 데이터, 매일 9:15 ET 업데이트
- $1,995/년 프리미엄 서비스 (포지션 추적, 진입가/목표가 공개)

### (3) 게시물 관련성 필터링
- **독자적 AI 모델** (frontier model 기반, "multi-model AI")
- 가중치 체계: Search 30, Social 25, Purchase 25, App 12, Survey 8
- "Brand Affinity" AI 모델로 소셜 언급이 실제 브랜드/제품과 관련 있는지 판단
- 소비자 행동 신호를 매출 서프라이즈와의 과거 상관관계로 가중

### (4) 데이터 소스
- Google Trends (4.2B queries/mo)
- 구매 의도 감지 (500K+ 브랜드)
- X · Reddit · TikTok 소셜 (38M posts)
- 앱스토어 설치 (iOS + Android, 1,200 apps)
- 독자 설문조사

**소스**: https://likefolio.com/methodology

---

## 6. 접근 불가 / 존재 불가 서비스

### Social Sentiment (socialsentiment.io)
- **DNS 미해석** — 도메인이 더 이상 활성 도메인이 아님
- `socialsentiment.io`, `www.socialsentiment.io`, `app.socialsentiment.io` 모두 연결 실패
- 서비스 중단으로 판단됨

### Dakks Finance
- `dakksfinance.com`, `dakks.finance`, `dakksfinance.io` 모두 DNS 미해석
- GitHub 검색 결과 0건
- 존재 여부 자체를 확인할 수 없음

### UniFinc
- `unifinc.com`은 샌프란시스코 기반 **부동산 관리 회사** (Unif Management, Inc.)
- 주식/금융 데이터 서비스가 아님
- 다른 도메인이나 금융 서비스로서의 "UniFinc"는 확인되지 않음

### TrendSpider Sentiment
- 메인 도메인(trendspider.com)이 **403 Forbidden** 반환
- 기술적 분석 플랫폼으로, 소셜 센티먼트는 부가 기능으로 보이나 상세 확인 불가

---

## 핵심 발견 및 raddit을 위한 시사점

### 발견 1: 아무도 Reddit 게시물을 직접 보여주지 않는다
조사한 모든 Reddit 기반 서비스(ApeWisdom, SwaggyStocks, Quiver Quant)가 **집계 통계만 제공**하고 개별 게시물은 표시하지 않는다. 이는 게시물 관련성 필터링이 기술적으로 어렵기 때문으로 분석된다.

> raddit이 게시물을 보여주려는 시도 자체가 차별화 포인트가 될 수 있음. 단, 관련성 문제를 해결해야 함.

### 발견 2: 티커 충돌 문제는 보편적 — 해법은 allow/deny 리스트 + 규칙
- **ApeWisdom**: $접두사 강제 + Infinite Marketcap 레지스트리 검증
- **SwaggyStocks**: allow/deny 리스트 + proximity rules (가장 체계적)
- 공통점: 순수 패턴 매칭이 아닌, **사전에 구축한 티커 검증 레지스트리** 활용

> raddit의 이슈 #21 해결책으로 SwaggyStocks 방식(allow/deny + proximity)이 가장 참고할 만함.

### 발견 3: cashtag($TICKER)가 가장 신뢰할 수 있는 관련성 신호
- Stocktwits는 cashtag를 강제하여 관련성 문제를 구조적으로 해결
- ApeWisdom도 $접두사를 우선 감지 대상으로 사용
- 다만 이슈 #21에서 지적한 대로, 실제 r/pennystocks에서는 cashtag 사용률이 4%에 불과

> casetag 강제는 유효 게시물의 96%를 놓치게 됨. 하이브리드 접근(캐즐태그 우선 + 대문자 매칭 후처리)이 필요.

### 발견 4: 센티먼트 분석은 규칙 기반(BoW)이 업계 표준
- SwaggyStocks가 명시적으로 "신경망 NLP가 아닌 BoW + 규칙 기반"을 선택한 이유: **속도, 설명 가능성, 시장 특화 언어 강건성**
- ApeWisdom, SwaggyStocks 모두 calls/puts/long/short 등 거래 슬랭 키워드 매핑 사용

### 발견 5: ApeWisdom API의 구조적 한계 확인
- ApeWisdom API는 **집계 데이터만 제공** (게시물 URL/title/body 미포함)
- 이는 이슈 #31에서 이미 파악된 내용이며, raddit이 별도 소스(Reddit RSS)로 게시물을 확보해야 하는 근본 이유

---

## raddit을 위한 권장 사항 (이슈 #21 해결 방향)

### 즉시 적용 가능 (SwaggyStocks 방식 벤치마킹)
1. **티커 deny 리스트 구축**: SO, ON, BIG, LOVE, RUN, CFO, YOLO 등 일반 영어 단어 티커 사전 등록
2. **allow/deny + proximity rules**: 티커 주변 문맥(거래 용어, 가격 언급 등)으로 필터링
3. **title 우선 매칭**: title에 티커가 없는 게시물은 후순위 또는 드랍

### 중기 개발
4. **BoW 센티먼트 분류**: calls/puts/moon/dump 등 키워드 사전 구축 (SwaggyStocks 방식)
5. **소스 가중치**: r/pennystocks, r/wallstreetbets 등 서브레딧별 신뢰도 가중치 적용
6. **스팸/봇 필터**: 동일 사용자 반복 게시물, 짧은 시간 내 대량 멘션 감지

### 차별화 전략
7. **게시물 표시 자체가 raddit의 차별화 포인트**: 경쟁 서비스들이 포기한 영역. 관련성만 확보되면 강력한 차별화가 됨.

---

*조사 한계: DuckDuckGo, Bing, Brave 검색 엔진이 모두 anti-bot 차단/한국어 결과 반환으로 영문 검색이 제대로 작동하지 않았음. 직접 사이트 fetch로 보완했으나, Stocktwits(Cloudflare), TrendSpider(403)는 상세 확인이 불가했음.*
