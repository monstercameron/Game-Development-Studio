#include <cuda_runtime.h>
#include <cstdio>

__global__ void check_kernel(int *value) { *value = 42; }

int main() {
    int count = 0, result = 0;
    int *device = nullptr;
    cudaError_t error = cudaGetDeviceCount(&count);
    if (error != cudaSuccess || count < 1) {
        std::fprintf(stderr, "No CUDA device: %s\n", cudaGetErrorString(error));
        return 1;
    }
    error = cudaMalloc(&device, sizeof(int));
    if (error == cudaSuccess) {
        check_kernel<<<1, 1>>>(device);
        error = cudaGetLastError();
    }
    if (error == cudaSuccess) error = cudaMemcpy(&result, device, sizeof(int), cudaMemcpyDeviceToHost);
    if (device) cudaFree(device);
    if (error != cudaSuccess || result != 42) {
        std::fprintf(stderr, "CUDA kernel failed: %s, result=%d\n", cudaGetErrorString(error), result);
        return 1;
    }
    cudaDeviceProp properties{};
    if (cudaGetDeviceProperties(&properties, 0) != cudaSuccess) return 1;
    std::printf("Native CUDA kernel passed on %s (compute %d.%d).\n", properties.name, properties.major, properties.minor);
    return 0;
}
