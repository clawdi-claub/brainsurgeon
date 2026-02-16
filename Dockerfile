FROM python:3.12-slim

WORKDIR /app

RUN pip install fastapi uvicorn pydantic

COPY api/ ./api/

ENV OPENCLAW_DATA=/data

EXPOSE 8654

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8654"]
