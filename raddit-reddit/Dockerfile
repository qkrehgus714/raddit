# raddit-reddit — Reddit 게시물 수집 RPC 마이크로서비스
# 작은 이미지를 위해 slim 베이스. deps가 fastapi/uvicorn 뿐이라 빌드가 가볍다.
FROM python:3.12-slim

WORKDIR /app

# 의존성을 먼저 설치해 레이어 캐시 활용
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드
COPY app.py reddit.py ./

# Railway/Heroku 등은 PORT 환경변수를 주입한다. 로컬 기본은 8000.
ENV PORT=8000
EXPOSE 8000

# uvicorn 단일 프로세스. 트래픽이 커지면 worker 수 조정.
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT}
