// Launch a Drama 3 worker with a bounded pageable working set. Keep the worker
// suspended until both the limit and kill-on-close job have been installed.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdio>
#include <string>

namespace {
constexpr SIZE_T kMinimumWorkingSet = 32ULL * 1024 * 1024;
constexpr SIZE_T kMaximumWorkingSet = 2ULL * 1024 * 1024 * 1024;

// Windows parses a command line rather than receiving an argv array. Quote each
// argument according to CommandLineToArgvW/MSVC backslash and quote rules.
std::wstring quote_argument(const wchar_t* argument) {
    std::wstring output = L"\"";
    size_t slashes = 0;
    for (const wchar_t* p = argument; *p; ++p) {
        if (*p == L'\\') {
            ++slashes;
        } else if (*p == L'\"') {
            output.append(slashes * 2 + 1, L'\\');
            output.push_back(L'\"');
            slashes = 0;
        } else {
            output.append(slashes, L'\\');
            output.push_back(*p);
            slashes = 0;
        }
    }
    output.append(slashes * 2, L'\\');
    output.push_back(L'\"');
    return output;
}

int fail(const char* stage, DWORD error) {
    std::fprintf(stderr, "Drama 3 launcher %s failed (Windows error %lu).\n", stage,
                 static_cast<unsigned long>(error));
    return 1;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        std::fputs("Drama 3 launcher requires an engine executable.\n", stderr);
        return 1;
    }

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return fail("job creation", GetLastError());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        const DWORD error = GetLastError();
        CloseHandle(job);
        return fail("job configuration", error);
    }

    std::wstring command;
    for (int i = 1; i < argc; ++i) {
        if (i != 1) command.push_back(L' ');
        command += quote_argument(argv[i]);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) {
        const DWORD error = GetLastError();
        CloseHandle(job);
        return fail("process creation", error);
    }

    const char* failed_stage = nullptr;
    if (!AssignProcessToJobObject(job, child.hProcess)) {
        failed_stage = "job assignment";
    } else if (!SetProcessWorkingSetSizeEx(child.hProcess, kMinimumWorkingSet,
                                            kMaximumWorkingSet, QUOTA_LIMITS_HARDWS_MAX_ENABLE)) {
        failed_stage = "memory limit";
    } else if (ResumeThread(child.hThread) == static_cast<DWORD>(-1)) {
        failed_stage = "process resume";
    }
    if (failed_stage) {
        const DWORD error = GetLastError();
        TerminateProcess(child.hProcess, 1);
        WaitForSingleObject(child.hProcess, INFINITE);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return fail(failed_stage, error);
    }

    CloseHandle(child.hThread);
    const DWORD wait = WaitForSingleObject(child.hProcess, INFINITE);
    DWORD exit_code = 1;
    if (wait != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {
        const DWORD error = GetLastError();
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return fail("process wait", error);
    }
    CloseHandle(child.hProcess);
    CloseHandle(job);
    return static_cast<int>(exit_code);
}
