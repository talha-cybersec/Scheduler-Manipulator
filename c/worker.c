/*
 * worker.c - a CPU-bound process whose speed can be measured
 *
 * Repeats a fixed block of work (5 million floating-point multiplications)
 * forever and, after each block, prints its throughput in blocks per second:
 *
 *     <name> <blocks_per_second>
 *
 * The backend reads this from stdout. When the scheduler gives the worker
 * less CPU time (lower priority, or a shared core), the number drops.
 */
#include <stdio.h>
#include <time.h>

int main(int argc, char *argv[]) {
    const char *name = argc > 1 ? argv[1] : "worker";
    struct timespec t1, t2;

    while (1) {
        clock_gettime(CLOCK_MONOTONIC, &t1);
        volatile double x = 1.0;
        for (int i = 0; i < 5000000; i++) x *= 1.0000001;
        clock_gettime(CLOCK_MONOTONIC, &t2);

        double elapsed_ms = (t2.tv_sec - t1.tv_sec) * 1000.0 +
                            (t2.tv_nsec - t1.tv_nsec) / 1e6;
        printf("%s %.2f\n", name, 1000.0 / elapsed_ms);
        fflush(stdout);
    }
    return 0;
}
