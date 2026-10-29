-- migrate:up
CREATE TABLE legacy (id int);
ALTER TABLE pets ADD COLUMN tag text;
-- старая таблица больше не нужна: разрушающая строка, находка класса
DROP TABLE legacy;

-- migrate:down
ALTER TABLE pets DROP COLUMN tag;
