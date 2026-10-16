FROM python:3.10-slim
WORKDIR /app
RUN apt-get update && apt-get install -y \
    openssh-client \
    sshpass \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*
# SSH config NU mai e necesar - parametrii sunt in linia de comanda!
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY mac_parser.py .
EXPOSE 5000
CMD ["python", "app.py"]