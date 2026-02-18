FROM python:3.12-slim

WORKDIR /app

RUN pip install fastapi uvicorn pydantic slowapi

COPY api/ ./api/

EXPOSE 8654

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8654", "--proxy-headers"]
