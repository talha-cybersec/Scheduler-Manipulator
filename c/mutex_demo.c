/*
 * mutex_demo.c - real priority inversion with POSIX threads
 *
 * Three SCHED_FIFO threads share ONE CPU core:
 *   LOW  (priority 10) locks a mutex and needs 1000 ms of CPU to finish
 *   HIGH (priority 30) needs the same mutex
 *   MED  (priority 20) never touches the mutex, it just burns 2000 ms of CPU
 *
 * Without priority inheritance, MED preempts LOW while LOW holds the lock,
 * so HIGH is stuck behind a LOWER-priority thread: priority inversion
 * (the bug that kept resetting NASA's Mars Pathfinder in 1997).
 *
 * Run with --inherit to create the mutex with PTHREAD_PRIO_INHERIT:
 * LOW is boosted to HIGH's priority while it holds the lock, MED can no
 * longer preempt it, and HIGH gets the mutex much sooner.
 *
 * Needs root (or CAP_SYS_NICE) because it uses real-time scheduling.
 *   sudo ./mutex_demo            # inversion
 *   sudo ./mutex_demo --inherit  # fixed with priority inheritance
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PRIO_LOW   10
#define PRIO_MED   20
#define PRIO_HIGH  30
#define PRIO_MAIN  40   /* main thread must outrank the workers to create them */

#define LOW_WORK_MS 1000
#define MED_WORK_MS 2000

static pthread_mutex_t shared_mutex;
static struct timespec start;
static double high_wait_ms = 0.0;

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (t.tv_sec - start.tv_sec) * 1000.0 + (t.tv_nsec - start.tv_nsec) / 1e6;
}

/* Burn `ms` milliseconds of this thread's own CPU time (not wall-clock time),
 * so time spent preempted does not count as work done. */
static void burn_cpu(double ms) {
    struct timespec t0, t;
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t0);
    do {
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t);
    } while ((t.tv_sec - t0.tv_sec) * 1000.0 + (t.tv_nsec - t0.tv_nsec) / 1e6 < ms);
}

static void say(const char *who, const char *what) {
    printf("%s: [%6.0f ms] %s\n", who, now_ms(), what);
    fflush(stdout);
}

static void *low_task(void *arg) {
    (void)arg;
    say("LOW", "locking the mutex");
    pthread_mutex_lock(&shared_mutex);
    say("LOW", "holding the mutex, doing 1000 ms of work");
    burn_cpu(LOW_WORK_MS);
    say("LOW", "releasing the mutex");
    pthread_mutex_unlock(&shared_mutex);
    return NULL;
}

static void *med_task(void *arg) {
    (void)arg;
    say("MED", "started, using the CPU for 2000 ms (does not need the mutex)");
    burn_cpu(MED_WORK_MS);
    say("MED", "finished");
    return NULL;
}

static void *high_task(void *arg) {
    (void)arg;
    say("HIGH", "needs the mutex NOW");
    double t0 = now_ms();
    pthread_mutex_lock(&shared_mutex);
    high_wait_ms = now_ms() - t0;
    say("HIGH", "finally got the mutex");
    pthread_mutex_unlock(&shared_mutex);
    return NULL;
}

static int start_thread(pthread_t *t, void *(*fn)(void *), int prio) {
    pthread_attr_t attr;
    struct sched_param sp = { .sched_priority = prio };
    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
    pthread_attr_setschedparam(&attr, &sp);
    int rc = pthread_create(t, &attr, fn, NULL);
    pthread_attr_destroy(&attr);
    return rc;
}

static void sleep_ms(long ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

int main(int argc, char *argv[]) {
    int inherit = (argc > 1 && strcmp(argv[1], "--inherit") == 0);

    /* 1. Put every thread on CPU core 0 so they really compete for one CPU. */
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(0, &set);
    if (sched_setaffinity(0, sizeof(set), &set) != 0) {
        printf("ERROR: could not pin to core 0: %s\n", strerror(errno));
        return 1;
    }

    /* 2. Main thread becomes the highest real-time priority. */
    struct sched_param sp = { .sched_priority = PRIO_MAIN };
    int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
    if (rc != 0) {
        printf("ERROR: real-time scheduling not allowed (%s). Run with sudo.\n", strerror(rc));
        return 1;
    }

    /* 3. The shared mutex, with or without priority inheritance. */
    pthread_mutexattr_t ma;
    pthread_mutexattr_init(&ma);
    pthread_mutexattr_setprotocol(&ma, inherit ? PTHREAD_PRIO_INHERIT : PTHREAD_PRIO_NONE);
    pthread_mutex_init(&shared_mutex, &ma);
    pthread_mutexattr_destroy(&ma);

    clock_gettime(CLOCK_MONOTONIC, &start);
    say("INFO", inherit ? "mode: PRIORITY INHERITANCE ON (the fix)"
                        : "mode: no inheritance (priority inversion)");
    say("INFO", "all threads pinned to CPU core 0, SCHED_FIFO priorities LOW=10 MED=20 HIGH=30");

    pthread_t low, med, high;
    if (start_thread(&low, low_task, PRIO_LOW) != 0) { printf("ERROR: cannot start LOW\n"); return 1; }
    sleep_ms(200);                                   /* LOW locks the mutex and starts working */
    if (start_thread(&high, high_task, PRIO_HIGH) != 0) { printf("ERROR: cannot start HIGH\n"); return 1; }
    sleep_ms(100);                                   /* HIGH blocks on the mutex */
    if (start_thread(&med, med_task, PRIO_MED) != 0) { printf("ERROR: cannot start MED\n"); return 1; }

    pthread_join(high, NULL);
    pthread_join(low, NULL);
    pthread_join(med, NULL);

    printf("RESULT: HIGH waited %.0f ms for the mutex (%s)\n", high_wait_ms,
           inherit ? "priority inheritance let LOW finish first"
                   : "MED delayed LOW, so HIGH was blocked by a lower-priority task");
    fflush(stdout);
    return 0;
}
