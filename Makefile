VENV   := .venv
PIP    := $(VENV)/bin/pip
PYTHON := $(VENV)/bin/python
DAYS   ?= 14

$(VENV)/bin/activate: requirements.txt
	python3 -m venv $(VENV)
	$(PIP) install -q -r requirements.txt
	@touch $(VENV)/bin/activate

.PHONY: sync backfill notify notify-dry serve clean

sync: $(VENV)/bin/activate
	$(PYTHON) sync.py

backfill: $(VENV)/bin/activate
	$(PYTHON) sync.py --backfill --days $(DAYS)

notify: $(VENV)/bin/activate
	$(PYTHON) notify.py

notify-dry: $(VENV)/bin/activate
	$(PYTHON) notify.py --dry-run

serve: $(VENV)/bin/activate
	$(PYTHON) app.py

clean:
	rm -rf $(VENV)
