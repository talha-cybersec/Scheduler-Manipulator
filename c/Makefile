CC     = gcc
CFLAGS = -O0 -Wall -Wextra

all: worker mutex_demo

worker: worker.c
	$(CC) $(CFLAGS) -o worker worker.c

mutex_demo: mutex_demo.c
	$(CC) $(CFLAGS) -o mutex_demo mutex_demo.c -lpthread

clean:
	rm -f worker mutex_demo

.PHONY: all clean
