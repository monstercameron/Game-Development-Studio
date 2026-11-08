import subprocess

from app_log import get_logger

log = get_logger("image")


def unlogged(path):
    try:
        path.unlink()
    except OSError:
        pass
    subprocess.run(["tool.exe"], check=True)


def logged(job):
    try:
        job.run()
    except RuntimeError as error:
        log.warn("image.job.failed", {"error": error})
    job.status = "done"
    log.info("job.state.changed", {"to": "done"})
