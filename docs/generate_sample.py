"""Generate docs/sample.csv: a synthetic ``id,text`` corpus for exercising CSV import.

    python docs/generate_sample.py            # 30,000 rows -> docs/sample.csv
    python docs/generate_sample.py --rows 5000 --out /tmp/small.csv

Pure lorem-ipsum would embed as noise and Leiden would find no structure, so each row
is written about one of a dozen topics: a topic template filled with Faker entities
(companies, cities, people, dates, numbers) plus a sentence drawn from the topic's own
vocabulary. About one row in eight is Romanian (``ro_RO``) so cross-lingual semantic
search has something to find. The seed is fixed, so the file is reproducible.
"""

from __future__ import annotations

import argparse
import csv
import random
from pathlib import Path

from faker import Faker

TOPICS: dict[str, dict[str, list[str]]] = {
    "transport": {
        "templates": [
            "{company} announced a {amount} million euro plan to modernise railway stations in {city}.",
            "Commuters in {city} face delays after signalling failures on the intercity rail line.",
            "The transport ministry approved new high-speed rail connections between {city} and {city2}.",
            "{name} said the new tram depot in {city} will double the fleet by {year}.",
            "Freight operators expect port traffic in {city} to grow after the rail upgrade.",
        ],
        "words": ["railway", "train", "station", "tracks", "freight", "commuters", "timetable", "signalling", "tram", "metro"],
        "ro": [
            "Guvernul pregătește investiții noi în infrastructura de căi ferate din {city}.",
            "Călătorii din {city} se confruntă cu întârzieri pe linia feroviară spre {city2}.",
        ],
    },
    "sports": {
        "templates": [
            "A late goal from {name} decided a tense football match in {city} on {date}.",
            "The {city} basketball team signed {name} on a {amount}-year contract.",
            "Fans celebrated in {city} after the club qualified for the European cup final.",
            "{name} won the marathon in {city} with a personal best time.",
            "The tennis championship in {city} was interrupted by rain during the semi-final.",
        ],
        "words": ["match", "goal", "coach", "stadium", "league", "season", "tournament", "players", "referee", "final"],
        "ro": [
            "Echipa din {city} a câștigat meciul de fotbal după un gol marcat în ultimul minut.",
            "{name} a câștigat maratonul de la {city}.",
        ],
    },
    "security": {
        "templates": [
            "{company} released a patch for an authentication flaw affecting its VPN appliances.",
            "Researchers found a remote code execution vulnerability in a popular logging library.",
            "A ransomware attack disrupted hospital systems in {city} for {amount} hours.",
            "{company} rotated all API keys after credentials leaked in a public repository.",
            "Security teams were urged to enable multi-factor authentication after a phishing wave.",
        ],
        "words": ["vulnerability", "patch", "exploit", "ransomware", "phishing", "credentials", "firewall", "malware", "breach", "encryption"],
        "ro": [
            "{company} a publicat un patch pentru o vulnerabilitate de autentificare.",
            "Un atac ransomware a afectat sistemele spitalului din {city}.",
        ],
    },
    "weather": {
        "templates": [
            "Forecasters warned of heavy snow and freezing temperatures across {city} this weekend.",
            "A heatwave pushed temperatures above {amount} degrees in {city} on {date}.",
            "Flash floods closed several roads near {city} after a night of intense rain.",
            "Strong winds knocked down trees and power lines in {city}.",
            "Meteorologists expect a mild, dry autumn for the region around {city2}.",
        ],
        "words": ["storm", "rain", "snow", "temperature", "forecast", "wind", "flood", "drought", "heatwave", "clouds"],
        "ro": [
            "Meteorologii avertizează că vin ninsori abundente și ger în {city}.",
            "Caniculă în {city}: temperaturile depășesc {amount} de grade.",
        ],
    },
    "ai": {
        "templates": [
            "{company} released a new language model that summarises long documents in seconds.",
            "Researchers showed that retrieval-augmented generation reduces hallucinations in chat assistants.",
            "{name} argued that vector databases are becoming core infrastructure for search.",
            "A startup in {city} raised {amount} million to build AI agents for customer support.",
            "Engineers fine-tuned an embedding model to improve multilingual semantic search.",
        ],
        "words": ["model", "embedding", "neural", "training", "inference", "transformer", "dataset", "agents", "retrieval", "benchmark"],
        "ro": [
            "{company} a lansat un model de limbaj care rezumă documente lungi.",
            "Cercetătorii din {city} au antrenat un model pentru căutare semantică.",
        ],
    },
    "energy": {
        "templates": [
            "{company} will build a {amount} megawatt solar park near {city}.",
            "Electricity prices fell after new wind farms came online around {city}.",
            "The grid operator warned of peak demand as temperatures dropped in {city}.",
            "A battery storage project in {city} will stabilise the regional power grid.",
            "{name} said nuclear refurbishment will keep the plant running until {year}.",
        ],
        "words": ["solar", "wind", "grid", "electricity", "battery", "power", "renewable", "turbine", "nuclear", "megawatt"],
        "ro": [
            "{company} va construi un parc fotovoltaic lângă {city}.",
            "Prețul energiei electrice a scăzut după punerea în funcțiune a noilor turbine eoliene.",
        ],
    },
    "databases": {
        "templates": [
            "The team migrated a {amount} terabyte PostgreSQL cluster with zero downtime.",
            "{company} explained how it sharded its Elasticsearch indices to cut query latency.",
            "Engineers traced slow queries to a missing index on the orders table.",
            "A new release of the graph database adds faster community detection algorithms.",
            "{name} compared write amplification in LSM trees and B-trees at a conference in {city}.",
        ],
        "words": ["index", "query", "replication", "shard", "schema", "transaction", "latency", "cluster", "backup", "storage"],
        "ro": [
            "Echipa a migrat un cluster PostgreSQL fără întreruperi.",
            "Inginerii au găsit cauza interogărilor lente: un index lipsă.",
        ],
    },
    "platform": {
        "templates": [
            "Kafka consumer lag spiked after a deployment at {company} on {date}.",
            "The platform team moved {amount} services to Kubernetes and cut costs.",
            "An expired TLS certificate caused a short outage for the {city} data centre.",
            "{name} described how feature flags made rollbacks safer at {company}.",
            "Engineers added autoscaling rules after traffic doubled during the sale.",
        ],
        "words": ["deployment", "kubernetes", "latency", "outage", "container", "monitoring", "rollback", "pipeline", "observability", "autoscaling"],
        "ro": [
            "Întârzierea consumatorilor Kafka a crescut după o nouă lansare la {company}.",
            "Echipa de platformă a mutat {amount} servicii în Kubernetes.",
        ],
    },
    "finance": {
        "templates": [
            "{company} shares rose {amount} percent after quarterly earnings beat forecasts.",
            "The central bank kept interest rates unchanged, citing slowing inflation.",
            "Investors in {city} moved money into bonds as markets turned volatile.",
            "{name} warned that rising mortgage rates could cool the housing market.",
            "The euro strengthened against the dollar after the inflation report on {date}.",
        ],
        "words": ["inflation", "interest", "shares", "bonds", "earnings", "market", "investors", "currency", "dividend", "budget"],
        "ro": [
            "Banca centrală a menținut dobânda de politică monetară neschimbată.",
            "Acțiunile {company} au crescut cu {amount} la sută după rezultatele trimestriale.",
        ],
    },
    "health": {
        "templates": [
            "Doctors in {city} reported a rise in seasonal flu cases on {date}.",
            "A new clinic in {city} will offer free screening for heart disease.",
            "{company} started a clinical trial for a vaccine against a respiratory virus.",
            "{name} said regular exercise lowers the risk of type 2 diabetes.",
            "Hospitals in {city2} extended visiting hours after the outbreak ended.",
        ],
        "words": ["patients", "hospital", "vaccine", "treatment", "doctors", "clinic", "disease", "therapy", "symptoms", "nutrition"],
        "ro": [
            "Medicii din {city} raportează o creștere a cazurilor de gripă.",
            "Un nou spital din {city} oferă screening gratuit.",
        ],
    },
    "food": {
        "templates": [
            "A family bakery in {city} won a national award for its sourdough bread.",
            "Chef {name} opened a restaurant in {city} focused on seasonal vegetables.",
            "Food prices rose {amount} percent as drought hit wheat harvests.",
            "The {city} street food festival attracted thousands of visitors on {date}.",
            "Nutritionists recommend replacing sugary drinks with water and tea.",
        ],
        "words": ["restaurant", "recipe", "chef", "bakery", "harvest", "cuisine", "menu", "flavour", "ingredients", "dessert"],
        "ro": [
            "O brutărie din {city} a câștigat un premiu național pentru pâinea cu maia.",
            "Festivalul de mâncare stradală din {city} a atras mii de vizitatori.",
        ],
    },
    "education": {
        "templates": [
            "Universities in {city} will offer {amount} new scholarships for engineering students.",
            "Teachers in {city} protested over salaries and overcrowded classrooms.",
            "{name} launched an online course on data science that enrolled thousands.",
            "The ministry announced a new curriculum focused on digital skills.",
            "Students from {city} won gold at the international mathematics olympiad.",
        ],
        "words": ["students", "university", "teachers", "curriculum", "exam", "school", "scholarship", "lecture", "classroom", "research"],
        "ro": [
            "Universitățile din {city} oferă {amount} burse noi pentru studenți.",
            "Elevii din {city} au câștigat aur la olimpiada internațională de matematică.",
        ],
    },
}


def build_row(fake: Faker, fake_ro: Faker, rng: random.Random, topic: str, index: int) -> tuple[str, str]:
    spec = TOPICS[topic]
    romanian = rng.random() < 0.125
    local = fake_ro if romanian else fake
    values = {
        "company": local.company(),
        "city": local.city(),
        "city2": local.city(),
        "name": local.name(),
        "date": fake.date_between(start_date="-2y", end_date="today").isoformat(),
        "year": str(rng.randint(2027, 2040)),
        "amount": str(rng.randint(2, 950)),
    }
    pool = spec["ro"] if romanian else spec["templates"]
    template = rng.choice(pool)
    parts = [template.format(**values)]
    if romanian:
        # Place and date make otherwise identical Romanian sentences distinct rows.
        parts.append(f"({values['city2']}, {values['date']})")
    else:
        # A second sentence from the topic's own vocabulary keeps rows distinct while
        # holding them in the same region of embedding space.
        parts.append(fake.sentence(nb_words=rng.randint(8, 16), ext_word_list=spec["words"] + fake.words(12)))
        if rng.random() < 0.35:
            parts.append(rng.choice([t for t in pool if t != template]).format(**values))
    return f"{topic[:4]}-{index:06d}", " ".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rows", type=int, default=30_000)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("sample.csv"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    Faker.seed(args.seed)
    rng = random.Random(args.seed)
    fake, fake_ro = Faker("en_US"), Faker("ro_RO")
    topics = list(TOPICS)

    with args.out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(["id", "text"])
        for index in range(1, args.rows + 1):
            writer.writerow(build_row(fake, fake_ro, rng, rng.choice(topics), index))
    print(f"Wrote {args.rows:,} rows to {args.out}")


if __name__ == "__main__":
    main()
