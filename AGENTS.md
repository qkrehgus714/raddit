# AGENTS.md — raddit

> ## ⚠️ 모든 작업 전에 [CONTRIBUTING.md](./CONTRIBUTING.md) 를 무조건 먼저 읽어라.
>
> 이 파일은 AI 코딩 에이전트(pi · Claude Code · Cursor 등)의 진입점이다.
> 기본 제약 · 브랜치 워크플로우 · 커밋/이슈/PR 스타일 · CHANGELOG 규칙은
> **전부 `CONTRIBUTING.md`에 정의되어 있다.** 여기서 중복 정의하지 않는다.
> (`CLAUDE.md`는 본 파일의 심볼릭 링크.)

---

## 에이전트 필수 수칙 (요약 — 전문은 CONTRIBUTING.md)

아래는 진입 즉시 보여주기 위한 요약. **상세·예외·템플릿은 반드시 CONTRIBUTING.md를 본다.**

1. **`main` / `dev` 직접 push 금지** — 항상 토픽 브랜치 → PR.
2. **모든 변경은 `이슈 → PR`** — PR 본문에 `Closes #N` 연결.
3. **개발 논의가 나오면 "이슈로 등록하자" 우선 제안** — 채팅에서만 끝내지 않는다.
4. **커밋·푸시·배포는 명시적 지시가 있을 때만.**

> 모호하거나 예외 상황이면 CONTRIBUTING.md와 사용자에게 **먼저 확인** 후 진행.
