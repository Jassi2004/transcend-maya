# Reproduce the connected demo

Clone the three repositories as siblings named `maya`, `company-a`, and `company-b`.

```sh
git clone https://github.com/Jassi2004/transcend-maya maya
git clone https://github.com/Jassi2004/transcend-company-a company-a
git clone https://github.com/Jassi2004/transcend-company-b company-b
cd maya/demo
```

Create `.env` here containing three distinct random keys: `MAYA_ACCESS_TOKEN`, `COMPANY_A_TOKEN`, and `COMPANY_B_TOKEN`. Keep it private. Then run `docker compose up --build -d`. MAYA is at port 4200, Company A at 4100, Company B at 4300; all host bindings are loopback. Named volumes retain state across container restarts.

From the MAYA repo, `npm run test:connected` exercises the two real connectors. Set `MAYA_ACCESS_TOKEN` in the test process to the local operator key. Tests do not use production services or keys.
