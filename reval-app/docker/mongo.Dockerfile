FROM mongo:8.0.13
COPY --chmod=755 docker/mongo-start.sh /usr/local/bin/reval-mongo-start
COPY docker/mongo-create-user.js /docker-entrypoint-initdb.d/
COPY docker/mongo-ready.js /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/reval-mongo-start"]
