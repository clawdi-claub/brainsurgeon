FROM python:3.12-slim

# Create openclaw user (matching host UID/GID 1001:1001)
RUN groupadd -g 1001 openclaw && \
    useradd -u 1001 -g openclaw -m -s /bin/bash openclaw

WORKDIR /app

RUN pip install fastapi uvicorn pydantic

COPY api/ ./api/

# Change ownership to openclaw user
RUN chown -R openclaw:openclaw /app

ENV OPENCLAW_DATA=/data

EXPOSE 8654

USER openclaw

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8654"]
