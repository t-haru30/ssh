"""Portable gcloud bootstrap/deploy/schedule commands. --apply is required to change cloud resources."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[1]


def commands(a):
    p,r,n=a.project,a.region,a.name
    runtime=f'{n}-runtime@{p}.iam.gserviceaccount.com'
    scheduler=f'{n}-scheduler@{p}.iam.gserviceaccount.com'
    image=f'{r}-docker.pkg.dev/{p}/{n}/app:{a.tag}'
    common=['--project',p,'--quiet']
    def cmd(*parts): return ['gcloud',*parts,*common]
    if a.action=='bootstrap':
        yield cmd('services','enable','run.googleapis.com','firestore.googleapis.com','cloudscheduler.googleapis.com',
            'secretmanager.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','iam.googleapis.com')
        yield cmd('firestore','databases','create','--database',a.database,'--location',r,'--type','firestore-native','--delete-protection')
        yield cmd('artifacts','repositories','create',n,'--location',r,'--repository-format','docker')
        for identity in (f'{n}-runtime',f'{n}-scheduler'):
            yield cmd('iam','service-accounts','create',identity)
        yield cmd('projects','add-iam-policy-binding',p,'--member',f'serviceAccount:{runtime}','--role','roles/datastore.user')
        yield cmd('secrets','create',f'{n}-gemini','--replication-policy','automatic')
        yield cmd('secrets','add-iam-policy-binding',f'{n}-gemini','--member',f'serviceAccount:{runtime}','--role','roles/secretmanager.secretAccessor')
    elif a.action=='secret':
        if not a.secret_file: raise ValueError('--secret-file is required (plaintext key file, outside repository)')
        yield cmd('secrets','versions','add',f'{n}-gemini','--data-file',str(a.secret_file.resolve()))
    elif a.action=='deploy':
        env=f'CATALOG_STORE=firestore,GOOGLE_CLOUD_PROJECT={p},CATALOG_FIRESTORE_DATABASE={a.database},CATALOG_AGENT_ENABLED=0,FACILITY_REFRESH_ENABLED=0,CATALOG_DAILY_LIMIT={a.daily_limit},FACILITY_MEMORY_PATH=/tmp/conciergo/facility_memory.sqlite3'
        yield cmd('builds','submit',str(ROOT),'--tag',image)
        yield cmd('run','deploy',n,'--image',image,'--region',r,'--service-account',runtime,
            '--allow-unauthenticated' if a.public_web else '--no-allow-unauthenticated',
            '--min-instances','0','--max-instances','2','--memory','1Gi',
            '--update-env-vars',env+',CATALOG_ADMIN_ENABLED=0',
            '--update-secrets',f'GEMINI_API_KEY={n}-gemini:latest')
        # Admin is a distinct IAM-private service, never the public website.
        yield cmd('run','deploy',n+'-admin','--image',image,'--region',r,'--service-account',runtime,
            '--no-allow-unauthenticated','--invoker-iam-check',
            '--min-instances','0','--max-instances','2','--memory','1Gi',
            '--update-env-vars',env+',CATALOG_ADMIN_ENABLED=1',
            '--update-secrets',f'GEMINI_API_KEY={n}-gemini:latest')
        yield cmd('run','jobs','deploy',f'{n}-update','--image',image,'--region',r,'--service-account',runtime,
            '--command','python','--args=-m,app.catalog_job','--tasks','1','--parallelism','1','--max-retries','0',
            '--task-timeout','600s','--memory','1Gi','--update-env-vars',env,
            '--update-secrets',f'GEMINI_API_KEY={n}-gemini:latest')
        yield cmd('run','jobs','add-iam-policy-binding',f'{n}-update','--region',r,
            '--member',f'serviceAccount:{scheduler}','--role','roles/run.invoker')
    elif a.action=='schedule':
        # Explicit separate step, only AFTER migration and manual Job verification.
        yield cmd('scheduler','jobs','create','http',f'{n}-schedule','--location',r,'--schedule','*/10 * * * *',
            '--time-zone','Asia/Tokyo','--uri',f'https://run.googleapis.com/v2/projects/{p}/locations/{r}/jobs/{n}-update:run',
            '--http-method','POST','--message-body','{}','--oauth-service-account-email',scheduler,
            '--oauth-token-scope','https://www.googleapis.com/auth/cloud-platform','--max-retry-attempts','0')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['bootstrap','secret','deploy','schedule'])
    parser.add_argument('--project',required=True)
    parser.add_argument('--region',default='asia-northeast1')
    parser.add_argument('--database',default='catalog-agent')
    parser.add_argument('--name',default='catalog-experiment')
    parser.add_argument('--tag',default='latest',help='Prefer a Git commit hash for reproducible releases')
    parser.add_argument('--daily-limit',type=int,default=100)
    parser.add_argument('--secret-file',type=Path)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--public-web',action='store_true',help='Publish the visitor service; admin remains IAM-private')
    a=parser.parse_args()
    for value in (a.project,a.region,a.database,a.name,a.tag):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}',value): parser.error('Invalid resource identifier')
    if len(a.name)>20 or a.daily_limit<0: parser.error('name must be <=20 characters; daily-limit must be >=0')
    if a.apply and a.action == 'deploy':
        executable=shutil.which('gcloud') or shutil.which('gcloud.cmd')
        if not executable: raise RuntimeError('Install Google Cloud CLI first')
        check=subprocess.run([executable,'run','services','get-iam-policy',a.name+'-admin',
            '--project',a.project,'--region',a.region,'--format=json'],capture_output=True,text=True)
        if check.returncode == 0:
            policy=json.loads(check.stdout)
            if any(member in {'allUsers','allAuthenticatedUsers'}
                   for binding in policy.get('bindings',[]) for member in binding.get('members',[])):
                raise RuntimeError('Admin service has broad access. Remove public IAM grants before deployment.')
        elif 'NOT_FOUND' not in check.stderr and 'not found' not in check.stderr.lower():
            raise RuntimeError(check.stderr)
    for command in commands(a):
        print(subprocess.list2cmdline(command),flush=True)
        if a.apply:
            executable=shutil.which('gcloud') or shutil.which('gcloud.cmd')
            if not executable: raise RuntimeError('Install Google Cloud CLI first')
            result=subprocess.run([executable,*command[1:]],cwd=ROOT,capture_output=True,text=True)
            if result.returncode:
                # Only idempotent CREATE conflicts are safe to skip. Auth and other failures stop.
                if 'create' in command and ('ALREADY_EXISTS' in result.stderr or 'already exists' in result.stderr):
                    print('Resource already exists; preserved.')
                else:
                    raise RuntimeError(result.stderr)
            else:
                print(result.stdout)


if __name__=='__main__':
    main()
