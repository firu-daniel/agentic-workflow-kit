// CLI test fixture: a pipeline file that throws while being imported, so loading fails with its message.
throw new Error('PIPELINE_SECRET is not set');
