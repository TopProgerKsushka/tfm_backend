import yaml from "yaml";
import fs from "fs";

const config = yaml.parse(fs.readFileSync("./app-config.yml", "utf-8"));

export default config;
