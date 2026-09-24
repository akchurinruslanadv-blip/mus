package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	dbPath := "C:\\Users\\Admin\\Desktop\\musik-project\\data\\db\\musik.db"
	sqlPath := "C:\\Users\\Admin\\Desktop\\musik-project\\data\\db\\schema.sql"

	schemaSQL, err := os.ReadFile(sqlPath)
	if err != nil {
		log.Fatalf("failed to read schema: %v", err)
	}

	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=foreign_keys(1)", dbPath))
	if err != nil {
		log.Fatalf("failed to open db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(string(schemaSQL)); err != nil {
		log.Fatalf("failed to execute schema: %v", err)
	}

	log.Println("Database schema successfully initialized!")
}
